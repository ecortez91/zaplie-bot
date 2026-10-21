// filepath: tabs/backend/connectionsRoutes.js
// GitHub App "install -> select repositories" flow. The person installs the
// app choosing repos; GitHub redirects back to /github/setup with the
// installation id and our signed state. The id is then checked against the
// person's own GitHub user token (/github/verify) before it is tied to their
// oid.
const express = require('express');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const {
  signState,
  verifyState,
  signInstallState,
  verifyInstallState,
} = require('./githubOAuthState');
const connectionsStore = require('./connectionsStore');
const {
  listInstallationRepos,
  exchangeUserCode,
  userCanAccessInstallation,
} = require('./githubAppAuth');
const {
  GithubAppNotConfiguredError,
  installVerifyCallbackUri,
  portalUrl,
  requireGithubOAuth,
  requireGithubSlug,
} = require('./githubAppConfig');

const router = express.Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

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
  if (typeof installationId !== 'string' || !/^\d+$/.test(installationId)) {
    res.redirect(`${portalUrl()}?github=install_error`);
    return;
  }
  // The id is not trusted yet (GitHub documents that it can be spoofed). Send
  // the person through the App's user authorization; /github/verify saves the
  // installation only if their own token can see it.
  let clientId;
  let redirectUri;
  try {
    ({ clientId } = requireGithubOAuth());
    redirectUri = installVerifyCallbackUri();
  } catch (error) {
    console.error('Cannot verify the GitHub installation:', error.message);
    res.redirect(`${portalUrl()}?github=install_error`);
    return;
  }
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', signInstallState(oid, installationId));
  res.redirect(url.toString());
});

// GET /api/connections/github/verify — GitHub's user-authorization callback
// for the ownership check. The user token is used for one lookup and dropped:
// it is never stored, logged or sent to the browser.
router.get('/github/verify', async (req, res) => {
  const fail = () => res.redirect(`${portalUrl()}?github=install_error`);
  const { code } = req.query;
  const verified = verifyInstallState(req.query.state);
  if (!verified || typeof code !== 'string') {
    fail();
    return;
  }
  try {
    const { clientId, clientSecret } = requireGithubOAuth();
    const userToken = await exchangeUserCode({
      clientId,
      clientSecret,
      code,
      redirectUri: installVerifyCallbackUri(),
    });
    const owns = await userCanAccessInstallation(
      userToken,
      verified.installationId,
    );
    if (!owns) {
      console.error(
        `GitHub installation ${verified.installationId} is not accessible to the authorizing user`,
      );
      fail();
      return;
    }
    connectionsStore.setInstallation(verified.oid, verified.installationId);
    res.redirect(`${portalUrl()}?github=repos_connected`);
  } catch (error) {
    console.error('GitHub installation verification failed:', error.message);
    fail();
  }
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
