// filepath: tabs/backend/connectionsRoutes.js
// GitHub App "install -> select repositories" flow. The person installs the
// app choosing repos; GitHub redirects back to /github/setup with the
// installation id, which we tie to the caller's oid via the signed state.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { signState, verifyState } = require('./githubOAuthState');
const connectionsStore = require('./connectionsStore');
const { listInstallationRepos } = require('./githubAppAuth');
const {
  GithubAppNotConfiguredError,
  portalUrl,
  requireGithubSlug,
} = require('./githubAppConfig');

const router = express.Router();

const requireMsalOid = async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return null;
  }
  try {
    return await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return null;
  }
};

// POST /api/connections/github/install-url — caller authenticates with a real
// MSAL ID token; the signed state ties the install redirect back to their oid.
router.post('/github/install-url', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  let slug;
  try {
    slug = requireGithubSlug();
  } catch (error) {
    console.error(error.message);
    if (error instanceof GithubAppNotConfiguredError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'GitHub App configuration is unavailable' });
    return;
  }
  const installUrl = `https://github.com/apps/${slug}/installations/new?state=${signState(
    oid,
  )}`;
  res.json({ installUrl });
});

// GET /api/connections/github/setup — the App's setup URL (set by the
// manifest). GitHub redirects the browser here after an install or, with
// setup_on_update, after the repository selection changes, passing
// installation_id, setup_action and the state from our install link.
router.get('/github/setup', (req, res) => {
  const {
    installation_id: installationId,
    setup_action: setupAction,
    state,
  } = req.query;
  // An org member without rights asked an owner to install: nothing exists yet.
  if (setupAction === 'request') {
    res.redirect(`${portalUrl()}?github=install_requested`);
    return;
  }
  const oid = typeof state === 'string' ? verifyState(state) : null;
  if (!oid) {
    // A change made on GitHub's own settings page carries no state of ours.
    // The installation was recorded when it was created and its repositories
    // are listed live, so there is nothing to write.
    const status = setupAction === 'update' ? 'repos_updated' : 'install_error';
    res.redirect(`${portalUrl()}?github=${status}`);
    return;
  }
  if (typeof installationId === 'string' && /^\d+$/.test(installationId)) {
    connectionsStore.setInstallation(oid, installationId);
    res.redirect(`${portalUrl()}?github=repos_connected`);
    return;
  }
  res.redirect(`${portalUrl()}?github=install_error`);
});

// GET /api/connections/github/repos — caller authenticates with a real MSAL ID
// token; "not connected" is a normal state, never an error.
router.get('/github/repos', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  const installationId = connectionsStore.getInstallation(oid);
  if (!installationId) {
    res.json({ connected: false, repositories: [] });
    return;
  }
  try {
    const repositories = await listInstallationRepos(installationId);
    res.json({ connected: true, repositories });
  } catch (error) {
    console.error('Listing installation repositories failed:', error.message);
    const status = error instanceof GithubAppNotConfiguredError ? 409 : 502;
    res.status(status).json({ error: error.message });
  }
});

// GET /api/connections/github — caller authenticates with a real MSAL ID token.
router.get('/github', async (req, res) => {
  const oid = await requireMsalOid(req, res);
  if (!oid) {
    return;
  }
  res.json({ connected: !!connectionsStore.getInstallation(oid) });
});

module.exports = router;
