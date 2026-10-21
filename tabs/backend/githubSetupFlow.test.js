// The whole zero-config path with no GITHUB_* env vars: an admin creates the
// App through the manifest flow, installs it on repositories through the App's
// setup URL, and the portal lists those repositories with the stored key.
// GitHub's API is stubbed at fetch; everything else is the real server.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-github-flow-'));
process.env.ZAPLIE_DATA_DIR = tempDir;
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';
process.env.PORTAL_URL = 'https://portal.example.com/settings';
for (const key of [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_SLUG',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
]) {
  delete process.env[key];
}

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const http = require('http');

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';

// Same require.cache stand-in as configRoutes.test.js.
const claimsFor = token => {
  if (token !== ADMIN_TOKEN && token !== USER_TOKEN) {
    throw new Error('invalid token');
  }
  return {
    oid: token === ADMIN_TOKEN ? 'oid-admin' : 'oid-user',
    roles: token === ADMIN_TOKEN ? ['Zaplie.Admin'] : [],
  };
};

const validatorPath = require.resolve('./msalValidator');
require.cache[validatorPath] = {
  id: validatorPath,
  filename: validatorPath,
  loaded: true,
  exports: {
    verifyMsalPayload: async token => claimsFor(token),
    verifyMsalToken: async token => claimsFor(token).oid,
    verifyMsalClaims: async token => claimsFor(token),
    extractBearerToken: req => {
      const header = req.headers['authorization'] || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  },
};

const app = require('./server');

// GitHub issues PKCS1 keys from the manifest conversion.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CODE = 'one-shot-code';
const INSTALLATION_ID = '4242';
const githubCalls = [];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const verifyAppJwt = authorization => {
  const [header, payload, signature] = authorization
    .replace(/^Bearer /, '')
    .split('.');
  const valid = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, signature, 'base64url');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  return valid && claims.iss === '777';
};

const stubGithub = async (url, options = {}) => {
  githubCalls.push({ url: String(url), method: options.method || 'GET' });
  if (url === `https://api.github.com/app-manifests/${CODE}/conversions`) {
    return json(201, {
      id: 777,
      slug: 'zaplie-rewards-beef',
      html_url: 'https://github.com/apps/zaplie-rewards-beef',
      client_id: 'Iv1.manifest',
      client_secret: 'manifest-secret',
      webhook_secret: 'manifest-webhook',
      pem: privateKey,
    });
  }
  if (
    url ===
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
  ) {
    return verifyAppJwt(options.headers.Authorization)
      ? json(201, { token: 'installation-token' })
      : json(401, { message: 'Bad credentials' });
  }
  if (String(url).startsWith('https://api.github.com/installation/repositories')) {
    assert.equal(options.headers.Authorization, 'Bearer installation-token');
    return json(200, {
      repositories: [
        {
          id: 1,
          full_name: 'acme/api',
          private: true,
          html_url: 'https://github.com/acme/api',
        },
      ],
    });
  }
  throw new Error(`unexpected GitHub call: ${url}`);
};

let server;
let base;
const realFetch = globalThis.fetch;

before(async () => {
  globalThis.fetch = stubGithub;
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// node:http, not fetch: the test's own calls must not hit the GitHub stub.
const call = (method, route, auth) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${route}`,
      { method, headers: auth ? { Authorization: auth } : {} },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            // Redirects stay null.
          }
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

const setupUrl = query => `/api/connections/github/setup?${query}`;

test('setup -> install -> connected repositories, with no GITHUB_* env vars', async () => {
  // 1. The admin fetches the manifest; installs come back to the setup URL.
  const manifestRes = await call(
    'GET',
    '/api/setup/github/manifest',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(manifestRes.status, 200);
  const manifest = JSON.parse(manifestRes.body.manifest);
  assert.equal(
    manifest.setup_url,
    'https://portal.example.com/api/connections/github/setup',
  );
  assert.equal(manifest.setup_on_update, true);
  assert.equal(manifest.request_oauth_on_install, false);
  const manifestState = new URL(manifestRes.body.action).searchParams.get(
    'state',
  );

  // 2. GitHub redirects back with a one-shot code; the conversion is stored.
  const created = await call(
    'GET',
    `/api/setup/github/callback?code=${CODE}&state=${manifestState}`,
  );
  assert.equal(created.status, 302);
  assert.equal(
    created.headers.location,
    'https://portal.example.com/automations?setup=github_created',
  );

  const status = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.deepEqual(status.body, {
    created: true,
    slug: 'zaplie-rewards-beef',
    htmlUrl: 'https://github.com/apps/zaplie-rewards-beef',
    source: 'manifest',
    installationReady: true,
  });

  // 3. "Connect repositories": the install link uses the stored slug.
  const install = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(install.status, 200);
  const installUrl = new URL(install.body.installUrl);
  assert.equal(
    installUrl.pathname,
    '/apps/zaplie-rewards-beef/installations/new',
  );
  const installState = installUrl.searchParams.get('state');

  // 4. GitHub sends the browser to the setup URL; the installation is recorded.
  const back = await call(
    'GET',
    setupUrl(
      `installation_id=${INSTALLATION_ID}&setup_action=install&state=${installState}`,
    ),
  );
  assert.equal(back.status, 302);
  assert.equal(
    back.headers.location,
    'https://portal.example.com/settings?github=repos_connected',
  );

  const connection = await call(
    'GET',
    '/api/connections/github',
    `Bearer ${USER_TOKEN}`,
  );
  assert.deepEqual(connection.body, { connected: true });

  // 5. The repositories are listed with an installation token minted from the
  // stored App key.
  const repos = await call(
    'GET',
    '/api/connections/github/repos',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.body, {
    connected: true,
    repositories: [
      {
        id: 1,
        fullName: 'acme/api',
        private: true,
        htmlUrl: 'https://github.com/acme/api',
      },
    ],
  });

  // The same stored client serves identity linking from Settings.
  const authorize = await call(
    'POST',
    '/api/identities/github/authorize-url',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(
    new URL(authorize.body.authorizeUrl).searchParams.get('client_id'),
    'Iv1.manifest',
  );
});

test('the setup URL records nothing without our signed state', async () => {
  const forged = await call(
    'GET',
    setupUrl('installation_id=999&setup_action=install&state=forged'),
  );
  assert.equal(
    forged.headers.location,
    'https://portal.example.com/settings?github=install_error',
  );

  // A repository change made on GitHub itself carries no state of ours.
  const update = await call(
    'GET',
    setupUrl('installation_id=999&setup_action=update'),
  );
  assert.equal(
    update.headers.location,
    'https://portal.example.com/settings?github=repos_updated',
  );

  const admin = await call(
    'GET',
    '/api/connections/github',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.deepEqual(admin.body, { connected: false });
});

test('an install request awaiting an org owner is reported, not an error', async () => {
  const res = await call('GET', setupUrl('setup_action=request'));
  assert.equal(
    res.headers.location,
    'https://portal.example.com/settings?github=install_requested',
  );
});

test('a non-numeric installation id is refused even with a valid state', async () => {
  const install = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${ADMIN_TOKEN}`,
  );
  const state = new URL(install.body.installUrl).searchParams.get('state');
  const res = await call(
    'GET',
    setupUrl(`installation_id=..%2F1&setup_action=install&state=${state}`),
  );
  assert.equal(
    res.headers.location,
    'https://portal.example.com/settings?github=install_error',
  );
  const admin = await call(
    'GET',
    '/api/connections/github',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.deepEqual(admin.body, { connected: false });
});
