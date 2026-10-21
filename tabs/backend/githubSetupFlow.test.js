// The whole zero-config path with no GITHUB_* env vars: an admin creates the
// App through the manifest flow and installs it on repositories through the
// App's setup URL; the installation is saved only after the installer's own
// GitHub token proves they can access it; the portal lists its repositories
// with the stored key; and a teammate links their GitHub identity with the
// stored OAuth client, which is what the reward flow resolves recipients by.
// GitHub and LNbits are stubbed at fetch; everything else is the real server.
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
process.env.LNBITS_NODE_URL = 'https://lnbits.test';
process.env.LNBITS_USERNAME = 'zaplie';
process.env.LNBITS_PASSWORD = 'lnbits-password';
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

const { signState } = require('./githubOAuthState');
const app = require('./server');

// GitHub issues PKCS1 keys from the manifest conversion.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ORIGIN = 'https://portal.example.com';
const SETTINGS = `${ORIGIN}/settings`;
const CODE = 'one-shot-code';
const INSTALLATION_ID = '4242';
const VERIFY_URI = `${ORIGIN}/api/connections/github/verify`;
const IDENTITY_URI = `${ORIGIN}/api/identities/github/callback`;
// User tokens the stub hands out. They must never be stored or logged.
const USER_TOKENS = {
  'install-code-owner': 'ghu_owner_token',
  'install-code-other': 'ghu_other_token',
  'identity-code': 'ghu_identity_token',
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

const userInstallationPages = {
  // The owner can see the installation, on the second page.
  ghu_owner_token: [[{ id: 1 }], [{ id: Number(INSTALLATION_ID) }]],
  ghu_other_token: [[{ id: 5 }]],
};

const stub = async (input, options = {}) => {
  const url = String(input);
  const auth = options.headers?.Authorization;
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
  if (url === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(options.body);
    // Only the stored manifest client is ever presented.
    assert.equal(body.client_id, 'Iv1.manifest');
    assert.equal(body.client_secret, 'manifest-secret');
    const expectedUri =
      body.code === 'identity-code' ? IDENTITY_URI : VERIFY_URI;
    assert.equal(body.redirect_uri, expectedUri);
    const token = USER_TOKENS[body.code];
    return json(200, token ? { access_token: token } : { error: 'bad_verification_code' });
  }
  if (url.startsWith('https://api.github.com/user/installations')) {
    const pages = userInstallationPages[auth.replace(/^Bearer /, '')];
    const page = Number(new URL(url).searchParams.get('page') || '1');
    const next =
      page < pages.length
        ? {
            link: `<https://api.github.com/user/installations?per_page=100&page=${
              page + 1
            }>; rel="next"`,
          }
        : {};
    return json(
      200,
      { total_count: pages.flat().length, installations: pages[page - 1] },
      next,
    );
  }
  if (url === 'https://api.github.com/user') {
    assert.equal(auth, 'Bearer ghu_identity_token');
    return json(200, { id: 583231, login: 'octocat' });
  }
  if (
    url ===
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
  ) {
    return verifyAppJwt(auth)
      ? json(201, { token: 'installation-token' })
      : json(401, { message: 'Bad credentials' });
  }
  if (url.startsWith('https://api.github.com/installation/repositories')) {
    assert.equal(auth, 'Bearer installation-token');
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
  if (url === 'https://lnbits.test/api/v1/auth') {
    return json(200, { access_token: 'lnbits-admin' });
  }
  if (url === 'https://lnbits.test/users/api/v1/user') {
    return json(200, {
      data: [{ id: 'lnbits-user-1', external_id: 'oid-user' }],
    });
  }
  throw new Error(`unexpected outbound call: ${url}`);
};

let server;
let base;
const realFetch = globalThis.fetch;
const logged = [];
const realConsole = {};

before(async () => {
  globalThis.fetch = stub;
  for (const level of ['log', 'warn', 'error']) {
    realConsole[level] = console[level];
    console[level] = (...args) => {
      logged.push(args.map(String).join(' '));
    };
  }
  await new Promise(resolve => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
  await new Promise(resolve => server.close(resolve));
  delete process.env.ZAPLIE_DATA_DIR;
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// node:http, not fetch: the test's own calls must not hit the stub.
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

const connected = async token =>
  (await call('GET', '/api/connections/github', `Bearer ${token}`)).body
    .connected;

// Starts an install as `token` and follows the setup URL with `installationId`,
// returning the GitHub authorize URL the portal sends the person to.
const installAndReturn = async (token, installationId) => {
  const install = await call(
    'POST',
    '/api/connections/github/install-url',
    `Bearer ${token}`,
  );
  const state = new URL(install.body.installUrl).searchParams.get('state');
  const back = await call(
    'GET',
    setupUrl(
      `installation_id=${installationId}&setup_action=install&state=${state}`,
    ),
  );
  assert.equal(back.status, 302);
  return new URL(back.headers.location);
};

const verify = (code, state) =>
  call('GET', `/api/connections/github/verify?code=${code}&state=${state}`);

test('setup -> install -> verified connection -> identity link, with no GITHUB_* env vars', async () => {
  // 1. The admin fetches the manifest; installs come back to the setup URL.
  const manifestRes = await call(
    'GET',
    '/api/setup/github/manifest',
    `Bearer ${ADMIN_TOKEN}`,
  );
  assert.equal(manifestRes.status, 200);
  const manifest = JSON.parse(manifestRes.body.manifest);
  assert.equal(manifest.setup_url, `${ORIGIN}/api/connections/github/setup`);
  assert.equal(manifest.setup_on_update, true);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.deepEqual(manifest.callback_urls, [IDENTITY_URI, VERIFY_URI]);
  const manifestState = new URL(manifestRes.body.action).searchParams.get(
    'state',
  );

  // 2. GitHub redirects back with a one-shot code; the conversion is stored.
  const created = await call(
    'GET',
    `/api/setup/github/callback?code=${CODE}&state=${manifestState}`,
  );
  assert.equal(created.headers.location, `${ORIGIN}/automations?setup=github_created`);
  const status = await call(
    'GET',
    '/api/setup/github/status',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(status.body.installationReady, true);
  assert.equal(status.body.source, 'manifest');

  // 3. Install, then GitHub's setup URL: nothing is saved yet. The person is
  // sent to authorize the App with the stored client and a verify state.
  const authorize = await installAndReturn(USER_TOKEN, INSTALLATION_ID);
  assert.equal(
    `${authorize.origin}${authorize.pathname}`,
    'https://github.com/login/oauth/authorize',
  );
  assert.equal(authorize.searchParams.get('client_id'), 'Iv1.manifest');
  assert.equal(authorize.searchParams.get('redirect_uri'), VERIFY_URI);
  assert.equal(await connected(USER_TOKEN), false);

  // 4. Their token can see the installation, so it is saved.
  const verified = await verify(
    'install-code-owner',
    authorize.searchParams.get('state'),
  );
  assert.equal(verified.headers.location, `${SETTINGS}?github=repos_connected`);
  assert.equal(await connected(USER_TOKEN), true);

  // 5. Repositories are listed with an installation token minted from the
  // stored App key (the stub checks the JWT against the stored key).
  const repos = await call(
    'GET',
    '/api/connections/github/repos',
    `Bearer ${USER_TOKEN}`,
  );
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.body.repositories, [
    {
      id: 1,
      fullName: 'acme/api',
      private: true,
      htmlUrl: 'https://github.com/acme/api',
    },
  ]);

  // 6. Identity linking with the stored OAuth client (the stub asserts the
  // stored client id and secret), then the lookup the reward flow uses:
  // GitHub numeric id -> Entra oid -> LNbits user.
  const identityStart = await call(
    'POST',
    '/api/identities/github/authorize-url',
    `Bearer ${USER_TOKEN}`,
  );
  const identityUrl = new URL(identityStart.body.authorizeUrl);
  assert.equal(identityUrl.searchParams.get('client_id'), 'Iv1.manifest');
  assert.equal(identityUrl.searchParams.get('redirect_uri'), IDENTITY_URI);
  const linked = await call(
    'GET',
    `/api/identities/github/callback?code=identity-code&state=${identityUrl.searchParams.get(
      'state',
    )}`,
  );
  assert.equal(linked.headers.location, `${SETTINGS}?github=connected`);

  const resolved = await call(
    'GET',
    '/api/identities/resolve?provider=github&providerId=583231',
    'test-internal-token',
  );
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body, {
    personAad: 'oid-user',
    lnbitsUserId: 'lnbits-user-1',
  });
});

test('a spoofed installation id the user cannot access is not saved', async () => {
  const authorize = await installAndReturn(ADMIN_TOKEN, '999');
  const res = await verify(
    'install-code-owner',
    authorize.searchParams.get('state'),
  );
  assert.equal(res.headers.location, `${SETTINGS}?github=install_error`);
  assert.equal(await connected(ADMIN_TOKEN), false);

  // Same installation id, but authorized by someone who cannot see it.
  const other = await installAndReturn(ADMIN_TOKEN, INSTALLATION_ID);
  const res2 = await verify(
    'install-code-other',
    other.searchParams.get('state'),
  );
  assert.equal(res2.headers.location, `${SETTINGS}?github=install_error`);
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('a failed token exchange saves nothing', async () => {
  const authorize = await installAndReturn(ADMIN_TOKEN, INSTALLATION_ID);
  const res = await verify('bad-code', authorize.searchParams.get('state'));
  assert.equal(res.headers.location, `${SETTINGS}?github=install_error`);
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('a tampered or wrong-purpose verify state saves nothing', async () => {
  const authorize = await installAndReturn(ADMIN_TOKEN, '999');
  const state = authorize.searchParams.get('state');

  // Swap the installation id inside the signed state: the signature breaks.
  const parts = Buffer.from(state, 'base64url').toString('utf8').split('|');
  assert.equal(parts[2], '999');
  parts[2] = INSTALLATION_ID;
  const tampered = Buffer.from(parts.join('|')).toString('base64url');
  const res = await verify('install-code-owner', tampered);
  assert.equal(res.headers.location, `${SETTINGS}?github=install_error`);

  // A plain identity/install state is not a verify state, and vice versa.
  const plain = await verify('install-code-owner', signState('oid-admin'));
  assert.equal(plain.headers.location, `${SETTINGS}?github=install_error`);
  const crossed = await call(
    'GET',
    setupUrl(`installation_id=${INSTALLATION_ID}&setup_action=install&state=${state}`),
  );
  assert.equal(crossed.headers.location, `${SETTINGS}?github=install_error`);
  const identity = await call(
    'GET',
    `/api/identities/github/callback?code=identity-code&state=${state}`,
  );
  assert.equal(identity.status, 400);

  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('the setup URL records nothing without our signed state', async () => {
  const forged = await call(
    'GET',
    setupUrl('installation_id=999&setup_action=install&state=forged'),
  );
  assert.equal(forged.headers.location, `${SETTINGS}?github=install_error`);

  // A repository change made on GitHub itself carries no state of ours.
  const update = await call(
    'GET',
    setupUrl('installation_id=999&setup_action=update'),
  );
  assert.equal(update.headers.location, `${SETTINGS}?github=repos_updated`);

  const request = await call('GET', setupUrl('setup_action=request'));
  assert.equal(request.headers.location, `${SETTINGS}?github=install_requested`);

  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('a non-numeric installation id is refused before any authorization', async () => {
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
  assert.equal(res.headers.location, `${SETTINGS}?github=install_error`);
  assert.equal(await connected(ADMIN_TOKEN), false);
});

test('GitHub user tokens are never stored or logged', () => {
  const tokens = Object.values(USER_TOKENS);
  for (const file of fs.readdirSync(tempDir)) {
    const text = fs.readFileSync(path.join(tempDir, file), 'utf8');
    for (const token of tokens) {
      assert.equal(text.includes(token), false, `${token} found in ${file}`);
    }
  }
  for (const line of logged) {
    for (const token of tokens) {
      assert.equal(line.includes(token), false, `${token} logged: ${line}`);
    }
  }
});
