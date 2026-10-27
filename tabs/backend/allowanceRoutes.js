// /api/allowances: the weekly allowance policy, the Fund status, and the
// preview/apply sync (tabs/backend/allowanceSync.js) for the Automations page.
//
// Reads take a signed-in user or the bot; everything that writes takes a
// Zaplie.Admin. No response ever carries a key: the Fund wallet is reported by
// id, name and balance only.
const express = require('express');
const { requireAdmin } = require('./adminAuth');
const { requireSignedInOrBot } = require('./readAuth');
const { extractBearerToken, verifyMsalClaims } = require('./msalValidator');
const {
  AllowancePolicyError,
  applyAllowancePolicyPatch,
  maxAllowanceSats,
  readAllowancePolicy,
} = require('./allowancePolicy');
const { AllowanceSyncError, isSyncRunning, runAllowanceSync } = require('./allowanceSync');
const {
  createAllowanceExtensionClient,
  readFundKeys,
} = require('./allowanceExtensionClient');
const { createAllowanceSyncStore } = require('./allowanceSyncStore');
const { timerSettings } = require('./allowanceTimer');

const SYNC_BODY_KEYS = new Set(['confirmTotalSats', 'overwriteDrift', 'allowUnderfunded']);
const RECENT_RUNS = 50;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Fund wallet(s) by id, name and balance, and the extension's health. */
const readFundStatus = async ({ env = process.env, clientFactory = createAllowanceExtensionClient } = {}) => {
  const keys = readFundKeys(env);
  if (keys.length === 0) {
    return { configured: false, wallets: [], health: null };
  }
  try {
    const clients = keys.map((key) => clientFactory(key));
    const wallets = [];
    for (const client of clients) {
      const { id, name, balanceSats } = await client.fundWallet();
      wallets.push({ id, name, balanceSats });
    }
    let health = null;
    try {
      const raw = await clients[0].health();
      health = {
        healthy: raw?.healthy === true,
        schedulerOk: raw?.scheduler_ok === true,
        lastCompleted: Number.isFinite(raw?.last_completed) ? raw.last_completed : null,
        overdue: Number.isFinite(raw?.overdue) ? raw.overdue : null,
        pending: Number.isFinite(raw?.pending) ? raw.pending : null,
      };
    } catch (_error) {
      health = null;
    }
    return { configured: true, wallets, health };
  } catch (_error) {
    // The upstream detail stays in the server: it is about the Fund key.
    return { configured: true, wallets: [], health: null, error: 'The Fund wallet could not be read.' };
  }
};

const sendError = (res, error, fallback) => {
  if (error instanceof AllowancePolicyError) {
    res.status(400).send({ message: error.message });
    return;
  }
  if (error instanceof AllowanceSyncError) {
    res.status(error.status).send({ message: error.message, code: error.code });
    return;
  }
  console.error(`${fallback}:`, error?.message || error);
  res.status(500).send({ message: fallback });
};

const callerOid = async (req) => {
  try {
    const claims = await verifyMsalClaims(extractBearerToken(req));
    return typeof claims?.oid === 'string' ? claims.oid : 'admin';
  } catch (_error) {
    return 'admin';
  }
};

const createAllowanceRouter = ({
  readData,
  writeData,
  store = createAllowanceSyncStore(),
  env = process.env,
  runSync = runAllowanceSync,
  fundStatus = () => readFundStatus({ env }),
}) => {
  const router = express.Router();

  // A stored policy that no longer validates is the server's problem (500),
  // not the caller's (400).
  const readStoredPolicy = (data) => {
    try {
      return readAllowancePolicy(data);
    } catch (error) {
      throw new AllowanceSyncError(
        `the stored allowance policy is invalid: ${error.message}`,
        500,
        'policy-invalid',
      );
    }
  };

  const status = async () => {
    const policy = readStoredPolicy(readData());
    const state = store.read();
    return {
      policy,
      maxAmountSats: maxAllowanceSats(),
      fund: await fundStatus(),
      lastRun: state.lastRun || null,
      lastAdminApply: state.lastAdminApply || null,
      running: isSyncRunning(),
      timer: timerSettings(env),
    };
  };

  router.get('/policy', requireSignedInOrBot, async (_req, res) => {
    try {
      res.send(await status());
    } catch (error) {
      sendError(res, error, 'Allowance status could not be read');
    }
  });

  router.post('/policy', requireAdmin, async (req, res) => {
    let next;
    try {
      const data = readData();
      next = applyAllowancePolicyPatch(readStoredPolicy(data), req.body, {
        by: await callerOid(req),
      });
      data.allowancePolicy = next;
      if (!writeData(data)) {
        res.status(500).send({ message: 'Allowance policy could not be persisted' });
        return;
      }
    } catch (error) {
      sendError(res, error, 'Allowance policy could not be saved');
      return;
    }
    try {
      res.send({ message: 'Allowance policy saved', ...(await status()) });
    } catch (error) {
      sendError(res, error, 'Allowance status could not be read');
    }
  });

  router.post('/sync', requireAdmin, async (req, res) => {
    const mode = req.query.mode;
    if (mode !== 'dry' && mode !== 'apply') {
      res.status(400).send({ message: "mode must be 'dry' or 'apply'" });
      return;
    }
    const body = req.body ?? {};
    if (!isPlainObject(body) || !Object.keys(body).every((key) => SYNC_BODY_KEYS.has(key))) {
      res.status(400).send({ message: 'only confirmTotalSats, overwriteDrift and allowUnderfunded are accepted' });
      return;
    }
    for (const flag of ['overwriteDrift', 'allowUnderfunded']) {
      if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
        res.status(400).send({ message: `${flag} must be true or false` });
        return;
      }
    }
    if (mode === 'apply' && !Number.isSafeInteger(body.confirmTotalSats)) {
      res.status(400).send({ message: 'apply needs confirmTotalSats from a preview' });
      return;
    }
    try {
      const result = await runSync({
        mode,
        confirmTotalSats: body.confirmTotalSats,
        overwriteDrift: body.overwriteDrift === true,
        allowUnderfunded: body.allowUnderfunded === true,
        by: await callerOid(req),
      }, { readData, store, env });
      res.send(result);
    } catch (error) {
      sendError(res, error, 'Allowance sync failed');
    }
  });

  router.get('/runs', requireAdmin, (_req, res) => {
    try {
      const { runs } = store.read();
      res.send({ runs: (runs || []).slice(-RECENT_RUNS).reverse() });
    } catch (error) {
      sendError(res, error, 'Allowance runs could not be read');
    }
  });

  return router;
};

module.exports = { createAllowanceRouter, readFundStatus };
