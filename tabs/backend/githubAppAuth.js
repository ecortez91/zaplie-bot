// filepath: tabs/backend/githubAppAuth.js
// GitHub App auth: mint the App JWT, exchange it for an installation token, and
// list the repos the installer selected. RS256 signing uses Node's built-in
// crypto (the private key GitHub issues is PKCS1, which crypto signs directly).
const crypto = require('crypto');
const { requestTimeoutSignal } = require('./httpTimeout');
const { requireGithubApp } = require('./githubAppConfig');

const base64url = (input) => Buffer.from(input).toString('base64url');

const createAppJwt = () => {
  const { appId, privateKeyPem } = requireGithubApp();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKeyPem, 'base64url');
  return `${signingInput}.${signature}`;
};

const getInstallationToken = async (installationId) => {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-connections',
      },
      signal: requestTimeoutSignal(),
    },
  );
  if (!response.ok) {
    throw new Error(`installation token request failed: ${response.status}`);
  }
  const body = await response.json();
  return body.token;
};

const nextPageUrl = (linkHeader) => {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match ? match[1] : null;
};

const listInstallationRepos = async (installationId) => {
  const token = await getInstallationToken(installationId);
  const repos = [];
  let url = 'https://api.github.com/installation/repositories?per_page=100';
  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-connections',
      },
      signal: requestTimeoutSignal(),
    });
    if (!response.ok) {
      throw new Error(`installation repositories request failed: ${response.status}`);
    }
    const body = await response.json();
    repos.push(
      ...body.repositories.map((repo) => ({
        id: repo.id,
        fullName: repo.full_name,
        private: repo.private,
        htmlUrl: repo.html_url,
      })),
    );
    url = nextPageUrl(response.headers.get('link'));
  }
  return repos;
};

// Exchanges a GitHub App user-authorization code for a user access token.
// The token is returned to the caller for one lookup and never stored.
const exchangeUserCode = async ({ clientId, clientSecret, code, redirectUri }) => {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: requestTimeoutSignal(),
  });
  if (!response.ok) {
    throw new Error(`user token exchange failed: ${response.status}`);
  }
  const body = await response.json();
  if (!body.access_token) {
    // body.error is GitHub's code (e.g. bad_verification_code), never a secret.
    throw new Error(`user token exchange returned no token: ${body.error}`);
  }
  return body.access_token;
};

// GitHub documents that the setup URL's installation_id can be spoofed, so
// ownership is checked against the installations this user can access.
const userCanAccessInstallation = async (userToken, installationId) => {
  let url = 'https://api.github.com/user/installations?per_page=100';
  while (url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'zaplie-connections',
      },
      signal: requestTimeoutSignal(),
    });
    if (!response.ok) {
      throw new Error(`user installations request failed: ${response.status}`);
    }
    const body = await response.json();
    if (
      body.installations.some(
        (installation) => String(installation.id) === installationId,
      )
    ) {
      return true;
    }
    const next = nextPageUrl(response.headers.get('link'));
    // The user token only ever goes to GitHub's API.
    url = next && next.startsWith('https://api.github.com/') ? next : null;
  }
  return false;
};

module.exports = {
  createAppJwt,
  getInstallationToken,
  listInstallationRepos,
  exchangeUserCode,
  userCanAccessInstallation,
};
