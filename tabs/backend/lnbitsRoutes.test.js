const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const express = require('express');
const { createLnbitsRouter, parseAmount } = require('./lnbitsRoutes');

const calls = [];
const service = {
  assertCaller: async (oid) => {
    if (oid === 'unlinked-oid') {
      const error = new Error('No LNbits user is linked to this account');
      error.status = 403;
      throw error;
    }
  },
  listUsers: async () => [{ id: 'user-1' }],
  getWalletBalance: async (walletId, aadObjectId) => {
    calls.push(['balance', { walletId, aadObjectId }]);
    return 42;
  },
  getWalletDetails: async (walletId, aadObjectId) => {
    calls.push(['details', { walletId, aadObjectId }]);
    return { id: walletId };
  },
  getWalletPayLinks: async (walletId, aadObjectId) => {
    calls.push(['paylinks', { walletId, aadObjectId }]);
    return [];
  },
  getInvoicePayment: async (walletId, invoiceId, aadObjectId) => {
    calls.push(['invoice-lookup', { walletId, invoiceId, aadObjectId }]);
    return {};
  },
  listWalletPayments: async (walletId, limit) => {
    calls.push(['payments', { walletId, limit }]);
    return [];
  },
  createOwnedInvoice: async (input) => {
    calls.push(['invoice', input]);
    return 'lnbc1invoice';
  },
  payOwnedInvoice: async (input) => {
    calls.push(['payment', input]);
    return { payment_hash: 'hash-1' };
  },
  sendZap: async (input) => {
    calls.push(['zap', input]);
    return { payment_hash: 'hash-2' };
  },
};

const extractBearerToken = (req) => {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  return match ? match[1] : null;
};

const verifyMsalPayload = async (token) => {
  if (token === 'valid-token') return { oid: 'caller-oid' };
  if (token === 'unlinked-token') return { oid: 'unlinked-oid' };
  throw new Error('bad token');
};

const app = express();
app.use(express.json());
app.use(
  '/api/lnbits',
  createLnbitsRouter({ service, extractBearerToken, verifyMsalPayload }),
);

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const request = (path, options = {}) =>
  fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.token
        ? { Authorization: `Bearer ${options.token}` }
        : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

test('requires a verified token and a linked LNbits user', async () => {
  assert.equal((await request('/api/lnbits/users')).status, 401);
  assert.equal(
    (await request('/api/lnbits/users', { token: 'unlinked-token' })).status,
    403,
  );
  const response = await request('/api/lnbits/users', { token: 'valid-token' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ id: 'user-1' }]);
});

test('derives wallet-write authorization from the verified oid', async () => {
  const response = await request('/api/lnbits/wallets/wallet-1/invoices', {
    method: 'POST',
    token: 'valid-token',
    body: { amount: 25, memo: 'thank you', aadObjectId: 'forged-oid' },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(calls.at(-1), [
    'invoice',
    {
      walletId: 'wallet-1',
      amount: 25,
      memo: 'thank you',
      aadObjectId: 'caller-oid',
    },
  ]);
});

test('wallet reads carry the verified oid so a wallet id alone grants nothing', async () => {
  const reads = [
    ['/api/lnbits/wallets/wallet-9', 'details'],
    ['/api/lnbits/wallets/wallet-9/balance', 'balance'],
    ['/api/lnbits/wallets/wallet-9/paylinks', 'paylinks'],
    ['/api/lnbits/wallets/wallet-9/payments/invoice-9', 'invoice-lookup'],
  ];

  for (const [path, kind] of reads) {
    const response = await request(path, { token: 'valid-token' });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1)[0], kind);
    assert.equal(calls.at(-1)[1].aadObjectId, 'caller-oid');
  }
});

test('wallet payment history stays tenant-wide for the feed', async () => {
  const response = await request('/api/lnbits/wallets/wallet-9/payments', {
    token: 'valid-token',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1), [
    'payments',
    { walletId: 'wallet-9', limit: 100 },
  ]);
});

test('rejects malformed or excessive zap amounts before calling LNbits', async () => {
  const callsBefore = calls.length;
  const response = await request('/api/lnbits/zaps', {
    method: 'POST',
    token: 'valid-token',
    body: { recipientUserId: 'user-2', amount: 1000001, memo: 'too much' },
  });

  assert.equal(response.status, 400);
  assert.equal(calls.length, callsBefore);
});

test('rejects non-numeric amounts that would otherwise coerce to a number', async () => {
  for (const amount of [true, ['5'], '25', null, 25.5]) {
    const callsBefore = calls.length;
    const response = await request('/api/lnbits/zaps', {
      method: 'POST',
      token: 'valid-token',
      body: { recipientUserId: 'user-2', amount, memo: 'coerced' },
    });

    assert.equal(response.status, 400);
    assert.equal(calls.length, callsBefore);
  }
});

test('rejects pagination values that are not plain integers', async () => {
  for (const limit of ['10.5', '1e3', '-1', '0', '9999', 'abc']) {
    const callsBefore = calls.length;
    const response = await request(
      `/api/lnbits/wallets/wallet-9/payments?limit=${limit}`,
      { token: 'valid-token' },
    );

    assert.equal(response.status, 400);
    assert.equal(calls.length, callsBefore);
  }
});

// The zap ceiling is ZAP_MAX_AMOUNT_SATS, not the reward ceiling.
// REWARDS_MAX_AMOUNT_SATS bounds automated rewards only; reusing it here gave
// this route a 1,000,000 default that contradicted its documented meaning.

// Both cap variables are process-wide, so each case sets exactly the state it
// describes and restores whatever the parent process had. Deleting an inherited
// value would silently change every case that runs after it.
const CAP_VARS = ['ZAP_MAX_AMOUNT_SATS', 'REWARDS_MAX_AMOUNT_SATS'];

const withCaps = (caps, assertions) => {
  const original = CAP_VARS.map((name) => [name, process.env[name]]);
  try {
    for (const name of CAP_VARS) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(caps)) {
      process.env[name] = value;
    }
    assertions();
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

test('with neither cap configured the ceiling is 1,000,000', () => {
  withCaps({}, () => {
    assert.equal(parseAmount(1_000_000), 1_000_000);
    assert.equal(parseAmount(1_000_001), null);
  });
});

// Separating the caps must not loosen a deployment that never asked for it:
// env/.env.dev.example ships REWARDS_MAX_AMOUNT_SATS=10000, and such a
// deployment keeps its 10,000-sat zap ceiling until it names a zap cap.
test('an unset zap cap inherits the configured reward cap', () => {
  withCaps({ REWARDS_MAX_AMOUNT_SATS: '10000' }, () => {
    assert.equal(parseAmount(10000), 10000);
    assert.equal(parseAmount(10001), null);
  });
});

test('ZAP_MAX_AMOUNT_SATS takes precedence over the reward cap', () => {
  withCaps(
    { REWARDS_MAX_AMOUNT_SATS: '10000', ZAP_MAX_AMOUNT_SATS: '500' },
    () => {
      assert.equal(parseAmount(500), 500);
      assert.equal(parseAmount(501), null);
    },
  );
});

test('a zap cap above the reward cap is honoured, not clamped to it', () => {
  withCaps(
    { REWARDS_MAX_AMOUNT_SATS: '10000', ZAP_MAX_AMOUNT_SATS: '50000' },
    () => {
      assert.equal(parseAmount(50000), 50000);
      assert.equal(parseAmount(50001), null);
    },
  );
});

test('a whitespace-only cap is unset, not malformed', () => {
  withCaps({ ZAP_MAX_AMOUNT_SATS: '   ', REWARDS_MAX_AMOUNT_SATS: '10000' }, () => {
    assert.equal(parseAmount(10000), 10000);
    assert.equal(parseAmount(10001), null);
  });
});

test('a malformed reward cap fails closed for zaps too', () => {
  withCaps({ REWARDS_MAX_AMOUNT_SATS: '1e3' }, () => {
    assert.throws(() => parseAmount(25), {
      message: 'REWARDS_MAX_AMOUNT_SATS must be a positive integer',
    });
  });
});

test('a malformed zap cap fails closed instead of widening the ceiling', async () => {
  for (const malformed of ['not-a-number', '-1', '0', '1.5', '0x10', '1e3']) {
    withCaps({ ZAP_MAX_AMOUNT_SATS: malformed }, () => {
      assert.throws(
        () => createLnbitsRouter({ service, extractBearerToken, verifyMsalPayload }),
        { message: 'ZAP_MAX_AMOUNT_SATS must be a positive integer' },
      );
    });
  }
});

test('a narrowed zap cap is enforced over HTTP', async () => {
  const originalCaps = CAP_VARS.map((name) => [name, process.env[name]]);
  CAP_VARS.forEach((name) => delete process.env[name]);
  process.env.ZAP_MAX_AMOUNT_SATS = '250';
  let cappedServer;
  try {
    const cappedApp = express();
    cappedApp.use(express.json());
    cappedApp.use(
      '/api/lnbits',
      createLnbitsRouter({ service, extractBearerToken, verifyMsalPayload }),
    );
    cappedServer = await new Promise((resolve) => {
      const listener = cappedApp.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const cappedUrl = `http://127.0.0.1:${cappedServer.address().port}`;
    const send = (amount) =>
      fetch(`${cappedUrl}/api/lnbits/zaps`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipientUserId: 'user-2', amount, memo: 'capped' }),
      });

    const callsBefore = calls.length;
    assert.equal((await send(251)).status, 400);
    assert.equal(calls.length, callsBefore);
    assert.equal((await send(250)).status, 200);
    assert.deepEqual(calls.at(-1)[1].amount, 250);
  } finally {
    for (const [name, value] of originalCaps) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (cappedServer) {
      await new Promise((resolve) => cappedServer.close(resolve));
    }
  }
});
