// The /api/allowances routes on a real Express app with stubbed MSAL: who may
// call what (401/403), what is refused (400/409/503), and that no response
// ever carries the Fund key.
process.env.TAB_BACKEND_TOKEN = 'test-internal-token';
process.env.AAD_TENANT_ID = 'test-tenant';
process.env.AAD_CLIENT_ID = 'test-client';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const ADMIN_TOKEN = 'admin-token';
const USER_TOKEN = 'user-token';
const ADMIN_OID = '11111111-2222-3333-4444-555555555555';
const FUND_KEY = 'a'.repeat(32);

const claimsFor = (token) => {
  if (token !== ADMIN_TOKEN && token !== USER_TOKEN) {
    throw new Error('invalid token');
  }
  return { oid: ADMIN_OID, roles: token === ADMIN_TOKEN ? ['Zaplie.Admin'] : [] };
};
const validatorPath = require.resolve('./msalValidator');
require.cache[validatorPath] = {
  id: validatorPath,
  filename: validatorPath,
  loaded: true,
  exports: {
    verifyMsalPayload: async (token) => claimsFor(token),
    verifyMsalToken: async (token) => claimsFor(token).oid,
    verifyMsalClaims: async (token) => claimsFor(token),
    extractBearerToken: (req) => {
      const header = req.headers.authorization || '';
      return header.startsWith('Bearer ') ? header.slice(7) : null;
    },
  },
};

const { createAllowanceRouter, readFundStatus } = require('./allowanceRoutes');
const { AllowanceSyncError } = require('./allowanceSync');
const { createAllowanceSyncStore } = require('./allowanceSyncStore');

// Test values only.
const POLICY = {
  enabled: true,
  amountSats: 25000,
  period: 'weekly',
  anchorWeekday: 5,
  anchorTime: '09:00',
  timezone: 'Europe/London',
};

let data = {};
let writes = 0;
let syncCalls = [];
let syncImpl = async () => ({ mode: 'dry', summary: { totalPerPeriodSats: 0 } });
const responses = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-routes-'));
const store = createAllowanceSyncStore({
  statePath: path.join(dir, 'state.json'),
  auditPath: path.join(dir, 'audit.jsonl'),
});

const fakeClientFactory = () => ({
  fundWallet: async () => ({ id: 'fund-1', name: 'Fund', balanceSats: 900000, adminkey: FUND_KEY }),
  health: async () => ({ healthy: true, scheduler_ok: true, last_completed: 1, overdue: 0, pending: 0, key: FUND_KEY }),
});

const app = express();
app.use(express.json());
app.use(
  '/api/allowances',
  createAllowanceRouter({
    readData: () => JSON.parse(JSON.stringify(data)),
    writeData: (next) => {
      data = next;
      writes += 1;
      return true;
    },
    store,
    env: { ALLOWANCE_FUND_ADMINKEY: FUND_KEY },
    runSync: async (options, deps) => {
      syncCalls.push({ options, deps });
      return syncImpl(options, deps);
    },
    fundStatus: () =>
      readFundStatus({ env: { ALLOWANCE_FUND_ADMINKEY: FUND_KEY }, clientFactory: fakeClientFactory }),
  }),
);

let server;
let base;
before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const call = (method, route, auth, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${base}${route}`,
      {
        method,
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          responses.push(raw);
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const admin = `Bearer ${ADMIN_TOKEN}`;
const user = `Bearer ${USER_TOKEN}`;

test('GET /policy: 401 without credentials; signed-in users and the bot read it', async () => {
  assert.equal((await call('GET', '/api/allowances/policy')).status, 401);
  assert.equal((await call('GET', '/api/allowances/policy', 'Bearer nope')).status, 401);

  const read = await call('GET', '/api/allowances/policy', user);
  assert.equal(read.status, 200);
  assert.equal(read.body.policy.enabled, false, 'the default policy is disabled');
  assert.equal(read.body.policy.amountSats, null);
  assert.deepEqual(read.body.fund.wallets, [{ id: 'fund-1', name: 'Fund', balanceSats: 900000 }]);
  assert.equal(read.body.fund.health.healthy, true);
  assert.equal(read.body.timer.intervalMinutes, 360);

  assert.equal((await call('GET', '/api/allowances/policy', 'test-internal-token')).status, 200);
});

test('POST /policy: 401, 403 for a non-admin, 400 for an invalid policy', async () => {
  assert.equal((await call('POST', '/api/allowances/policy', null, POLICY)).status, 401);
  assert.equal((await call('POST', '/api/allowances/policy', user, POLICY)).status, 403);
  const hidden = await call('POST', '/api/allowances/policy', admin, {
    ...POLICY,
    memo: 'Weekly Allowance cleared',
  });
  assert.equal(hidden.status, 400);
  assert.match(hidden.body.message, /hidden/);
  const incomplete = await call('POST', '/api/allowances/policy', admin, { enabled: true });
  assert.equal(incomplete.status, 400);
  const forged = await call('POST', '/api/allowances/policy', admin, { updatedBy: 'x' });
  assert.equal(forged.status, 400);
  assert.equal(writes, 0);
});

test('POST /policy: an admin saves; the server stamps who and when', async () => {
  const saved = await call('POST', '/api/allowances/policy', admin, POLICY);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.policy.enabled, true);
  assert.equal(saved.body.policy.updatedBy, ADMIN_OID);
  assert.ok(saved.body.policy.updatedAt);
  assert.equal(data.allowancePolicy.amountSats, 25000);
  assert.equal(writes, 1);
});

test('POST /sync: 401/403, and 400 for a bad mode, unknown keys or a missing confirm', async () => {
  assert.equal((await call('POST', '/api/allowances/sync?mode=dry', null, {})).status, 401);
  assert.equal((await call('POST', '/api/allowances/sync?mode=dry', user, {})).status, 403);
  assert.equal((await call('POST', '/api/allowances/sync?mode=go', admin, {})).status, 400);
  assert.equal((await call('POST', '/api/allowances/sync', admin, {})).status, 400);
  assert.equal(
    (await call('POST', '/api/allowances/sync?mode=dry', admin, { amountSats: 1 })).status,
    400,
  );
  assert.equal(
    (await call('POST', '/api/allowances/sync?mode=dry', admin, { overwriteDrift: 'yes' })).status,
    400,
  );
  assert.equal((await call('POST', '/api/allowances/sync?mode=apply', admin, {})).status, 400);
  assert.equal(syncCalls.length, 0);
});

test('POST /sync: a preview passes the admin through; apply errors keep their status', async () => {
  syncCalls = [];
  syncImpl = async () => ({ mode: 'dry', summary: { totalPerPeriodSats: 50000, changes: 2 } });
  const preview = await call('POST', '/api/allowances/sync?mode=dry', admin, { overwriteDrift: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.summary.totalPerPeriodSats, 50000);
  assert.equal(syncCalls[0].options.mode, 'dry');
  assert.equal(syncCalls[0].options.by, ADMIN_OID);
  assert.equal(syncCalls[0].options.overwriteDrift, true);
  assert.equal(syncCalls[0].options.allowUnderfunded, false);
  assert.equal(syncCalls[0].options.allowMassDelete, false);

  await call('POST', '/api/allowances/sync?mode=apply', admin, {
    confirmTotalSats: 50000,
    allowMassDelete: true,
  });
  assert.equal(syncCalls[1].options.allowMassDelete, true);
  assert.equal(
    (await call('POST', '/api/allowances/sync?mode=dry', admin, { allowMassDelete: 1 })).status,
    400,
  );

  syncImpl = async () => {
    throw new AllowanceSyncError('confirmTotalSats does not match the plan', 409, 'confirm-mismatch');
  };
  const mismatch = await call('POST', '/api/allowances/sync?mode=apply', admin, { confirmTotalSats: 1 });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'confirm-mismatch');

  syncImpl = async () => {
    throw new AllowanceSyncError('ALLOWANCE_FUND_ADMINKEY is not configured', 503, 'fund-not-configured');
  };
  const unconfigured = await call('POST', '/api/allowances/sync?mode=apply', admin, { confirmTotalSats: 0 });
  assert.equal(unconfigured.status, 503);

  syncImpl = async () => {
    throw new Error(`LNbits said no to ${FUND_KEY}`);
  };
  const unexpected = await call('POST', '/api/allowances/sync?mode=dry', admin, {});
  assert.equal(unexpected.status, 500);
  assert.equal(unexpected.body.message, 'Allowance sync failed');
});

test('POST /sync with the real sync: apply without a Fund key is a 503', async () => {
  const { runAllowanceSync } = require('./allowanceSync');
  const realApp = express();
  realApp.use(express.json());
  realApp.use(
    '/api/allowances',
    createAllowanceRouter({
      readData: () => ({ allowancePolicy: POLICY }),
      writeData: () => true,
      store,
      env: {},
      runSync: runAllowanceSync,
      fundStatus: async () => ({ configured: false, wallets: [], health: null }),
    }),
  );
  const realServer = await new Promise((resolve) => {
    const started = realApp.listen(0, () => resolve(started));
  });
  const previousBase = base;
  base = `http://127.0.0.1:${realServer.address().port}`;
  try {
    const result = await call('POST', '/api/allowances/sync?mode=apply', admin, { confirmTotalSats: 0 });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'fund-not-configured');
  } finally {
    base = previousBase;
    await new Promise((resolve) => realServer.close(resolve));
  }
});

test('POST /sync with the real sync: another process holding the lock is a 409 busy', async () => {
  const { runAllowanceSync } = require('./allowanceSync');
  const realApp = express();
  realApp.use(express.json());
  realApp.use(
    '/api/allowances',
    createAllowanceRouter({
      readData: () => ({ allowancePolicy: POLICY }),
      writeData: () => true,
      store,
      env: {},
      runSync: runAllowanceSync,
      fundStatus: async () => ({ configured: false, wallets: [], health: null }),
    }),
  );
  const realServer = await new Promise((resolve) => {
    const started = realApp.listen(0, () => resolve(started));
  });
  const previousBase = base;
  base = `http://127.0.0.1:${realServer.address().port}`;
  // The CLI, in another process, holds allowance-sync.lock.
  fs.writeFileSync(
    store.lockPath,
    JSON.stringify({ pid: 4242, host: 'cli-host', at: new Date().toISOString(), token: 'cli' }),
  );
  try {
    const status = await call('GET', '/api/allowances/policy', user);
    assert.equal(status.body.running, true);
    for (const mode of ['dry', 'apply']) {
      const result = await call('POST', `/api/allowances/sync?mode=${mode}`, admin, { confirmTotalSats: 0 });
      assert.equal(result.status, 409, mode);
      assert.equal(result.body.code, 'busy');
      assert.match(result.body.message, /pid 4242 on cli-host/);
    }
  } finally {
    fs.rmSync(store.lockPath, { force: true });
    base = previousBase;
    await new Promise((resolve) => realServer.close(resolve));
  }
  assert.equal((await call('GET', '/api/allowances/policy', user)).body.running, false);
});

test('GET /runs: admin only, newest first', async () => {
  store.write({
    ...store.read(),
    runs: [{ at: '2026-10-28T10:00:00Z' }, { at: '2026-10-29T10:00:00Z' }],
  });
  assert.equal((await call('GET', '/api/allowances/runs', user)).status, 403);
  const runs = await call('GET', '/api/allowances/runs', admin);
  assert.equal(runs.status, 200);
  assert.deepEqual(runs.body.runs.map((run) => run.at), ['2026-10-29T10:00:00Z', '2026-10-28T10:00:00Z']);
});

test('a stored policy that no longer validates is a 500, not a 400', async () => {
  const saved = data;
  data = { allowancePolicy: { enabled: true } };
  try {
    const read = await call('GET', '/api/allowances/policy', user);
    assert.equal(read.status, 500);
    assert.equal(read.body.code, 'policy-invalid');
  } finally {
    data = saved;
  }
});

test('no response ever carries the Fund key', () => {
  assert.ok(responses.length > 10);
  for (const raw of responses) {
    assert.equal(raw.includes(FUND_KEY), false, raw.slice(0, 200));
    // No key field either (the setting's name in a message is fine).
    assert.equal(/"(adminkey|inkey|key)"\s*:/i.test(raw), false, raw.slice(0, 200));
  }
});
