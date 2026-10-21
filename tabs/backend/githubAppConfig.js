// filepath: tabs/backend/githubAppConfig.js
// One reader for the GitHub App's configuration. Env wins when present (same
// rule as secretsStore.getOrCreateSecret, so existing deployments keep their
// values), otherwise the credentials the manifest flow stored are used.
// Each group (App signing key, OAuth client, slug) resolves from one source as
// a whole: an env app id is never paired with a stored private key.
const fs = require('fs');
const { getCredentials } = require('./githubAppCredentials');

const DEFAULT_PORTAL_URL = 'https://localhost:3000';
const NOT_CONFIGURED_MESSAGE =
  'GitHub app not created yet: an admin can create it from Automations';

class GithubAppNotConfiguredError extends Error {
  constructor() {
    super(NOT_CONFIGURED_MESSAGE);
    this.name = 'GithubAppNotConfiguredError';
    this.status = 409;
  }
}

const portalUrl = () =>
  (process.env.PORTAL_URL || '').trim().replace(/\/+$/, '') ||
  DEFAULT_PORTAL_URL;

// PORTAL_URL may point at a route (the identity docs set it to Settings), so
// anything served by this backend is addressed from the origin.
const portalOrigin = () => new URL(portalUrl()).origin;

const resolveApp = (stored) => {
  const appId = process.env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (appId && keyPath) {
    let privateKeyPem;
    try {
      privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    } catch (error) {
      throw new Error(
        `failed to read GitHub App private key at ${keyPath}: ${error.message}`,
      );
    }
    return { value: { appId, privateKeyPem }, source: 'env' };
  }
  if (stored?.appId && stored?.pem) {
    return {
      value: { appId: String(stored.appId), privateKeyPem: stored.pem },
      source: 'manifest',
    };
  }
  return { value: null, source: null };
};

const resolveOAuth = (stored) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  // The manifest registers this exact callback, so the derived value matches
  // the stored client; an explicit env value still wins for OAuth Apps.
  const redirectUri =
    process.env.GITHUB_OAUTH_REDIRECT_URI ||
    `${portalOrigin()}/api/identities/github/callback`;
  if (clientId && clientSecret) {
    return { value: { clientId, clientSecret, redirectUri }, source: 'env' };
  }
  if (stored?.clientId && stored?.clientSecret) {
    return {
      value: {
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        redirectUri,
      },
      source: 'manifest',
    };
  }
  return { value: null, source: null };
};

const resolveSlug = (stored) => {
  if (process.env.GITHUB_APP_SLUG) {
    return { value: process.env.GITHUB_APP_SLUG, source: 'env' };
  }
  if (stored?.slug) {
    return { value: stored.slug, source: 'manifest' };
  }
  return { value: null, source: null };
};

// source names where the App itself comes from: the signing key when one is
// configured, otherwise whichever group is.
const getGithubAppConfig = () => {
  const stored = getCredentials();
  const app = resolveApp(stored);
  const oauth = resolveOAuth(stored);
  const slug = resolveSlug(stored);
  return {
    app: app.value,
    slug: slug.value,
    oauth: oauth.value,
    source: app.source || oauth.source || slug.source,
  };
};

// Each require resolves only its own group, so an unreadable key file breaks
// the routes that sign with it and not the install or identity links.
const requireGroup = (resolve) => {
  const { value } = resolve(getCredentials());
  if (!value) throw new GithubAppNotConfiguredError();
  return value;
};

const requireGithubApp = () => requireGroup(resolveApp);
const requireGithubOAuth = () => requireGroup(resolveOAuth);
const requireGithubSlug = () => requireGroup(resolveSlug);

module.exports = {
  GithubAppNotConfiguredError,
  portalUrl,
  portalOrigin,
  getGithubAppConfig,
  requireGithubApp,
  requireGithubOAuth,
  requireGithubSlug,
};
