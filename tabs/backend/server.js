// filepath: /c:/projects/ZapVibes/tabs/backend/server.js
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const authMiddleware = require('./authMiddleware'); // Import the authentication middleware
const { dataPath } = require('./dataPaths');
const { writeJsonSecure } = require('./secureJsonStore');
const identityRoutes = require('./identityRoutes');
const pendingRewardsStore = require('./pendingRewardsStore');
const {
  migrateRewardAmounts,
  validateRewardAmountPatch,
} = require('./rewardAmounts');
const { validateBotPersona, readStoredBotPersona } = require('./botPersona');
const { maxRewardSats } = require('./rewardAmounts');
const {
  RewardPolicyError,
  applyRewardPolicyPatch,
  readRewardPolicy,
  validateRewardPolicy,
} = require('./rewardPolicy');

const app = express();
const port = process.env.PORT || 5000;

// Azure App Service fronts the app with a single proxy; without this the
// limiter would key every client on the proxy's IP.
app.set('trust proxy', 1);

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT) || 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
// Mounted app-wide, not on /api: CodeQL also flags the sendFile catch-all
// below (js/missing-rate-limiting), and every route does file or network work.
app.use(apiRateLimiter);
app.use(express.json());

// Deployment smoke tests need a dependency-free liveness signal. Readiness of
// authenticated LNbits operations is exercised separately by the API tests.
app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// All browser access to LNbits goes through this authenticated same-origin
// gateway. Wallet and service-account keys stay in the Node process.
app.use('/api/lnbits', require('./lnbitsRoutes'));

// Mounted before the generic authMiddleware below: its user-facing routes
// (authorize-url, mine) authenticate with a real MSAL token, not the
// shared backend token, and /resolve applies authMiddleware itself.
app.use('/api/identities', identityRoutes);

// Same reason: user-facing routes here authenticate with a real MSAL token
// (admin writes additionally require the Zaplie.Admin app role), and
// /connections/github/setup is GitHub's post-install browser redirect.
app.use('/api/connections', require('./connectionsRoutes'));
app.use('/api/webhook-keys', require('./webhookKeysRoutes'));
app.use('/api/automations-stats', require('./automationsStatsRoutes'));
app.use('/api/reports', require('./reportsRoutes'));

// Same reason: the manifest/callback routes are the admin's browser round trip
// to GitHub and apply their own admin check, not the shared backend token.
app.use('/api/setup', require('./setupRoutes'));

const { requireAdmin } = require('./adminAuth');
const { requireSignedInOrBot } = require('./readAuth');

// Mutable state must survive a clean deploy, so in production it lives
// outside the deployment tree: ZAPLIE_DATA_DIR points at a durable directory
// (for example /home/data/zaplie on Linux App Service). Unset - the local
// development default - keeps the store next to the code as before.
const dataFilePath = dataPath('data.json');

// Function to read data from the JSON file
const readData = () => {
  try {
    const data = fs.readFileSync(dataFilePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading data file:', error);
    return { rewardName: 'sats' }; // Default reward name
  }
};

// Function to write data to the JSON file
const writeData = (data) => {
  try {
    writeJsonSecure(dataFilePath, data);
    return true;
  } catch (error) {
    console.error('Error writing data file:', error);
    return false;
  }
};

// Admin config writes are registered before the shared-token authMiddleware:
// they authenticate with the caller's MSAL idToken + Zaplie.Admin app role.
app.post('/api/automations', requireAdmin, (req, res) => {
  const { repos } = req.body;
  if (Array.isArray(repos) && repos.every((repo) => typeof repo === 'string' && repo.length > 0)) {
    const data = readData();
    data.automations = { repos };
    if (!writeData(data)) {
      res.status(500).send({ message: 'Automations could not be persisted' });
      return;
    }
    res.send({ message: 'Automations updated successfully', repos: data.automations.repos });
  } else {
    res.status(400).send({ message: 'Invalid repos' });
  }
});

app.post('/api/reward-amounts', requireAdmin, (req, res) => {
  const { rewardAmounts } = req.body || {};
  const validation = validateRewardAmountPatch(rewardAmounts);
  if (!validation.valid) {
    res
      .status(validation.configurationError ? 500 : 400)
      .send({ message: validation.message });
    return;
  }

  const data = readData();
  let storedRewardAmounts;
  try {
    storedRewardAmounts = migrateRewardAmounts(data.rewardAmounts);
  } catch (error) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${error.message}`,
    });
    return;
  }
  // Only what an admin saved is stored: merging the defaults here would turn
  // one saved amount into three configured ones, and an unconfigured event
  // must pay nothing (the bot fails closed on it).
  const nextRewardAmounts = {
    ...storedRewardAmounts,
    ...rewardAmounts,
  };
  const storedValidation = validateRewardAmountPatch(nextRewardAmounts);
  if (!storedValidation.valid) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${storedValidation.message}`,
    });
    return;
  }

  // A new base must still leave room for the largest level bonus and every
  // per-person override under REWARDS_MAX_AMOUNT_SATS.
  let currentPolicy;
  try {
    currentPolicy = readRewardPolicy(data).rewardPolicy;
  } catch (error) {
    res.status(500).send({ message: `Stored reward policy is invalid: ${error.message}` });
    return;
  }
  try {
    validateRewardPolicy(currentPolicy, nextRewardAmounts, maxRewardSats());
  } catch (error) {
    res.status(400).send({ message: error.message });
    return;
  }

  data.rewardAmounts = nextRewardAmounts;
  if (!writeData(data)) {
    res.status(500).send({ message: 'Reward amounts could not be persisted' });
    return;
  }
  res.send({
    message: 'Reward amounts updated successfully',
    rewardAmounts: data.rewardAmounts,
  });
});

// The reward policy: level bonuses, per-person base overrides and the period
// budget. Each supplied top-level key replaces the stored one; anything else
// in the body is refused.
app.post('/api/reward-policy', requireAdmin, (req, res) => {
  const data = readData();
  let current;
  let cap;
  try {
    cap = maxRewardSats();
    current = readRewardPolicy(data);
  } catch (error) {
    res.status(500).send({ message: `Stored reward policy is invalid: ${error.message}` });
    return;
  }

  let nextPolicy;
  try {
    nextPolicy = applyRewardPolicyPatch(current, req.body, cap);
  } catch (error) {
    if (error instanceof RewardPolicyError) {
      res.status(400).send({ message: error.message });
      return;
    }
    throw error;
  }

  data.rewardPolicy = nextPolicy;
  if (!writeData(data)) {
    res.status(500).send({ message: 'Reward policy could not be persisted' });
    return;
  }
  res.send({
    message: 'Reward policy updated successfully',
    rewardAmounts: current.rewardAmounts,
    rewardPolicy: nextPolicy,
  });
});

// A body key this route does not read is a key the caller believed it could
// set, so the request is refused instead of silently half-honoured — the same
// contract the payment routes state in lnbitsRoutes.js.
const BOT_PERSONA_BODY_KEYS = new Set(['botPersona']);

const hasOnlyKeys = (body, allowed) =>
  typeof body === 'object' &&
  body !== null &&
  !Array.isArray(body) &&
  Object.keys(body).every(key => allowed.has(key));

// The persona is a system-prompt fragment for the assistant, so only an admin
// may set it and the value is validated before it ever reaches the bot. An
// empty string is a legitimate save: it puts the assistant back on its
// built-in voice.
app.post('/api/bot-persona', requireAdmin, (req, res) => {
  if (!hasOnlyKeys(req.body, BOT_PERSONA_BODY_KEYS)) {
    res.status(400).send({ message: 'botPersona is the only accepted field' });
    return;
  }

  const { botPersona } = req.body;
  const validation = validateBotPersona(botPersona);
  if (!validation.valid) {
    res.status(400).send({ message: validation.message });
    return;
  }

  const data = readData();
  data.botPersona = validation.botPersona;
  if (!writeData(data)) {
    res.status(500).send({ message: 'Bot persona could not be persisted' });
    return;
  }
  res.send({
    message: 'Bot persona updated successfully',
    botPersona: data.botPersona,
  });
});

// Config reads sit before the shared-token middleware because the browser
// cannot hold that secret. reward-name is deliberately open: the portal reads
// it before sign-in and blocks rendering on it. The others disclose connected
// repositories, payout policy and the assistant persona, so they take either a
// verified MSAL token or the bot's shared token.
// Endpoint to get the reward name
app.get('/api/reward-name', (req, res) => {
  const data = readData();
  res.send({ rewardName: data.rewardName });
});

// Endpoint to get the connected repository allowlist
app.get('/api/automations', requireSignedInOrBot, (req, res) => {
  const data = readData();
  res.send({ repos: data.automations?.repos || [] });
});

// Endpoint to get the admin-authored assistant persona. The bot reads it to
// build its instructions and the portal shows it to every signed-in user, so
// it takes either credential like the other config reads.
app.get('/api/bot-persona', requireSignedInOrBot, (req, res) => {
  const data = readData();
  res.send({ botPersona: readStoredBotPersona(data.botPersona) });
});

// Endpoint to get automation reward amounts. Only what an admin saved, no
// defaults merged: an unset event is not configured and pays nothing, the
// same fail-closed rule as /api/reward-policy and the bot.
app.get('/api/reward-amounts', requireSignedInOrBot, (req, res) => {
  const data = readData();
  try {
    const rewardAmounts = migrateRewardAmounts(data.rewardAmounts);
    if (Object.keys(rewardAmounts).length > 0) {
      const validation = validateRewardAmountPatch(rewardAmounts);
      if (!validation.valid) {
        throw new Error(validation.message);
      }
    }
    res.send({ rewardAmounts });
  } catch (error) {
    res.status(500).send({
      message: `Stored reward amounts are invalid: ${error.message}`,
    });
  }
});

// What the bot pays from, in one response: the amounts an admin saved (no
// defaults merged, so an unconfigured event is absent) and the validated
// policy. A malformed store is a 500, and the bot then refuses to pay.
app.get('/api/reward-policy', requireSignedInOrBot, (req, res) => {
  const data = readData();
  try {
    res.send(readRewardPolicy(data));
  } catch (error) {
    res.status(500).send({
      message: `Stored reward policy is invalid: ${error.message}`,
    });
  }
});

app.post('/api/reward-name', requireAdmin, (req, res) => {
  const { newRewardName } = req.body;
  if (newRewardName) {
    const data = readData();
    data.rewardName = newRewardName;
    if (!writeData(data)) {
      res.status(500).send({ message: 'Reward name could not be persisted' });
      return;
    }
    res.send({ message: 'Reward name updated successfully', rewardName: data.rewardName });
  } else {
    res.status(400).send({ message: 'Invalid reward name' });
  }
});

// Use the authentication middleware for API routes
app.use('/api', authMiddleware);

// Endpoint to update the reward name

// Endpoint the bot posts to when a reward's recipient can't be resolved to a
// Zaplie person yet (identity graph and env-map fallback both miss).
app.post('/api/pending-rewards', (req, res) => {
  const { provider, providerId, recipientLabel, amountSats, reason, source } = req.body || {};
  if (
    typeof provider !== 'string' ||
    typeof providerId !== 'string' ||
    typeof recipientLabel !== 'string' ||
    typeof amountSats !== 'number' ||
    typeof reason !== 'string' ||
    typeof source !== 'string'
  ) {
    res.status(400).send({ message: 'Invalid pending reward payload' });
    return;
  }
  pendingRewardsStore.addPendingReward({
    provider,
    providerId,
    recipientLabel,
    amountSats,
    reason,
    source,
  });
  res.status(201).send({ message: 'Pending reward recorded' });
});

// Serve the React app
app.use(express.static(path.join(__dirname, '../build')));

// A regular expression works with both Express 4 and path-to-regexp v8 in
// Express 5. Bare wildcard strings such as '*' throw during Express 5 startup.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, '../build', 'index.html'));
});

// Only listen when run directly, so tests can bind an ephemeral port.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;
