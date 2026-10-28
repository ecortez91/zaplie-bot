// server.js gives the allowance routes and timer a strict data.json reader. The
// lax one used by the config routes turns a corrupt file into defaults, which
// for allowances is a disabled policy: the timer would pause every schedule
// and POST /policy would write over every other setting. This loads the real
// app on a corrupt data.json, so the wiring cannot regress silently.
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const CORRUPT = '{not json';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-server-'));
const dataFile = path.join(dir, 'data.json');
fs.writeFileSync(dataFile, CORRUPT);

process.env.ZAPLIE_DATA_DIR = dir;
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';
// No Fund key and no LNbits: nothing here may reach a wallet.
delete process.env.ALLOWANCE_FUND_ADMINKEY;
delete process.env.LNBITS_NODE_URL;

const ADMIN_TOKEN = 'admin-token';
const validatorPath = require.resolve('./msalValidator');
const claimsFor = token => {
  if (token !== ADMIN_TOKEN) throw new Error('invalid token');
  return {
    oid: '11111111-2222-3333-4444-555555555555',
    roles: ['Zaplie.Admin'],
  };
};
require.cache[validatorPath] = {
  id: validatorPath,
  filename: validatorPath,
  loaded: true,
  exports: {
    verifyMsalPayload: async token => claimsFor(token),
    verifyMsalToken: async token => claimsFor(token).oid,
    verifyMsalClaims: async token => claimsFor(token),
    extractBearerToken: req => {
      const header = req.headers.authorization || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  },
};

const app = require('./server');

let server;
let base;
before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method, route, auth, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${base}${route}`,
      {
        method,
        headers: {
          Authorization: auth,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: raw ? JSON.parse(raw) : null,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

test('GET /api/allowances/policy on a corrupt data.json is 500 policy-invalid, not a disabled policy', async () => {
  const read = await call(
    'GET',
    '/api/allowances/policy',
    'test-internal-token',
  );
  assert.equal(read.status, 500);
  assert.equal(read.body.code, 'policy-invalid');
  assert.equal(read.body.policy, undefined);
});

test('POST /api/allowances/policy on a corrupt data.json is 500 and leaves the file alone', async () => {
  const saved = await call(
    'POST',
    '/api/allowances/policy',
    `Bearer ${ADMIN_TOKEN}`,
    {
      enabled: false,
    },
  );
  assert.equal(saved.status, 500);
  assert.equal(saved.body.code, 'policy-invalid');
  assert.equal(fs.readFileSync(dataFile, 'utf8'), CORRUPT);
});
