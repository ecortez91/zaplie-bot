// filepath: tabs/backend/setupRoutes.js
// GitHub App manifest flow (zero-config setup): an admin clicks once, GitHub
// creates the org's own Zaplie app and hands back the app id, private key,
// webhook secret and OAuth client credentials over the conversion API. No
// human ever copies a secret. Flow reference:
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
const express = require('express');
const crypto = require('crypto');
const { verifyMsalToken, extractBearerToken } = require('./msalValidator');
const { requireAdmin } = require('./adminAuth');
const { signState, verifyState } = require('./githubOAuthState');
const { getCredentials, saveCredentials } = require('./githubAppCredentials');
const { requestTimeoutSignal } = require('./httpTimeout');
const {
  getGithubSetupState,
  portalOrigin,
  portalUrl,
} = require('./githubAppConfig');

const router = express.Router();

// The admin starts the flow from Automations, so that is where it returns.
// Built from the origin because PORTAL_URL may point at the Settings route.
// This backend serves the portal too, so a PORTAL_URL that does not parse
// falls back to the same host rather than failing the redirect.
const automationsUrl = (status) => {
  const path = `/automations?setup=${status}`;
  try {
    return `${portalOrigin()}${path}`;
  } catch (error) {
    console.error(`PORTAL_URL is not a valid URL: ${error.message}`);
    return path;
  }
};

// GET /api/setup/github/status — non-secret creation state for the portal.
router.get('/github/status', async (req, res) => {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    await verifyMsalToken(token);
  } catch (error) {
    console.error('MSAL token validation failed:', error.message);
    res.status(401).json({ error: 'invalid token' });
    return;
  }
  let credentials;
  let state;
  try {
    credentials = getCredentials();
    // source: env, manifest or none. installationReady: the install link and
    // the App key both resolve, so "Connect repositories" can work end to end.
    state = getGithubSetupState();
  } catch (error) {
    console.error('GitHub App status failed:', error.message);
    res.status(500).json({ error: 'GitHub App status is unavailable' });
    return;
  }
  res.json(
    credentials
      ? {
          created: true,
          slug: credentials.slug,
          htmlUrl: credentials.htmlUrl,
          ...state,
        }
      : { created: false, ...state },
  );
});

// GET /api/setup/github/manifest — admin-only; returns the form-POST target
// and manifest JSON the browser submits to github.com/settings/apps/new.
router.get('/github/manifest', requireAdmin, async (req, res) => {
  const oid = 'admin'; // state binds the callback to a flow we started, not to a person
  const state = signState(oid);
  let origin;
  try {
    origin = portalOrigin();
  } catch (error) {
    // The manifest is baked into the App, so never register a guessed URL.
    console.error(`PORTAL_URL is not a valid URL: ${error.message}`);
    res.status(500).json({ error: 'PORTAL_URL is not a valid URL' });
    return;
  }
  const suffix = crypto.randomBytes(2).toString('hex');
  const manifest = {
    name: `zaplie-rewards-${suffix}`,
    url: portalUrl(),
    // This backend serves the portal, so its routes hang off the origin.
    redirect_url: `${origin}/api/setup/github/callback`,
    // Identity linking first (GitHub's default when no redirect_uri is sent),
    // then the install ownership check; every authorize request names one.
    callback_urls: [
      `${origin}/api/identities/github/callback`,
      `${origin}/api/connections/github/verify`,
    ],
    // Installs return to the connections route, which records the installation
    // against the signed state's oid; setup_on_update does the same when repos
    // are added or removed later. request_oauth_on_install stays off: with it
    // on, GitHub skips the setup URL and runs its own OAuth flow straight into
    // the identity callback, carrying no state and no installation to record.
    // People link their GitHub identity from Settings instead.
    setup_url: `${origin}/api/connections/github/setup`,
    setup_on_update: true,
    // hook_attributes and default_events are omitted until the webhook route
    // exists. The manifest is baked into every App created from it, so naming
    // a missing URL would leave a permanent 404 in each customer's App.
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      issues: 'read',
      pull_requests: 'read',
      metadata: 'read',
    },
  };
  res.json({
    action: `https://github.com/settings/apps/new?state=${state}`,
    manifest: JSON.stringify(manifest),
  });
});

// GET /api/setup/github/callback — GitHub redirects the browser here with a
// one-shot code; the conversion response carries every credential we need.
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  // Bind this callback to the manifest flow: /github/manifest mints
  // signState('admin'), and only that sentinel is accepted here. Identity- and
  // installation-flow states carry a real Entra oid, so they can't be replayed
  // to persist GitHub App credentials (cross-flow state confusion).
  if (
    typeof code !== 'string' ||
    typeof state !== 'string' ||
    verifyState(state) !== 'admin'
  ) {
    res.redirect(automationsUrl('github_error'));
    return;
  }
  try {
    const response = await fetch(
      `https://api.github.com/app-manifests/${code}/conversions`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'zaplie-setup',
        },
        signal: requestTimeoutSignal(),
      },
    );
    if (response.status !== 201) {
      throw new Error(`manifest conversion failed: ${response.status}`);
    }
    const app = await response.json();
    saveCredentials({
      appId: String(app.id),
      slug: app.slug,
      htmlUrl: app.html_url,
      clientId: app.client_id,
      clientSecret: app.client_secret,
      webhookSecret: app.webhook_secret,
      pem: app.pem,
      createdAt: new Date().toISOString(),
    });
    res.redirect(automationsUrl('github_created'));
  } catch (error) {
    console.error('GitHub App manifest conversion failed:', error.message);
    res.redirect(automationsUrl('github_error'));
  }
});

module.exports = router;
