const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  REQUEST_TIMEOUT_MS,
  getLnbitsToken,
  lnbitsGet,
} = require('./lnbitsAdmin');

const CONFIG = {
  nodeUrl: 'https://lnbits.test',
  username: 'service',
  password: 'secret',
};

const captureFetch = (body) => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
  return calls;
};

test('the LNbits request timeout is shared, not redeclared per module', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 10 * 1000);
});

test('the super-user login is bound by the request timeout', async () => {
  const realFetch = global.fetch;
  const calls = captureFetch({ access_token: 'token' });
  try {
    assert.equal(await getLnbitsToken(CONFIG), 'token');
  } finally {
    global.fetch = realFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://lnbits.test/api/v1/auth');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.signal.aborted, false);
});

test('admin GET requests are bound by the same timeout', async () => {
  const realFetch = global.fetch;
  const calls = captureFetch([{ id: 'user-1' }]);
  try {
    await lnbitsGet('https://lnbits.test/users/api/v1/user', 'token');
  } finally {
    global.fetch = realFetch;
  }

  assert.ok(calls[0].init.signal instanceof AbortSignal);
});
