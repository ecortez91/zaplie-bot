// The LNbits allowance extension (github.com/BenGWeeks/allowance), driven
// with the Fund wallet's admin key.
//
// D7: Zaplie never pays. The Fund key is the key of the wallet the extension
// pays from, so this client refuses to send it anywhere but the allowance and
// pay-link extension APIs and the read-only wallet endpoint. It never reaches
// /api/v1/payments. allowanceExtensionClient.test.js holds the allowlist.
const { lnbitsRequest, maskKeys } = require('./lnbitsGatewayService');

const FUND_KEY_ENV = 'ALLOWANCE_FUND_ADMINKEY';
const FUND_KEY_PATHS = [
  /^\/allowance\/api\/v1\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$/,
  /^\/lnurlp\/api\/v1\/[A-Za-z0-9/_-]*(\?[A-Za-z0-9=&_-]*)?$/,
];
const WALLET_READ_PATH = '/api/v1/wallet';
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const ALLOWANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

class FundKeyPathError extends Error {}

/** True when the Fund key may be sent to this method and path. */
const isFundKeyPathAllowed = (method, path) => {
  if (typeof path !== 'string') return false;
  if (path === WALLET_READ_PATH) return method === 'GET';
  return FUND_KEY_PATHS.some((pattern) => pattern.test(path));
};

/**
 * The configured Fund admin keys, in order. Comma-separated so more than one
 * Fund wallet can carry schedules (the extension allows 100 per wallet).
 * Never logged, stored or returned.
 */
const readFundKeys = (env = process.env) =>
  String(env[FUND_KEY_ENV] || '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requireAllowanceId = (id) => {
  if (typeof id !== 'string' || !ALLOWANCE_ID_PATTERN.test(id)) {
    throw new Error('invalid allowance id');
  }
  return id;
};

/**
 * A client bound to one Fund key. `request` is injectable for tests; it
 * defaults to the gateway's lnbitsRequest.
 */
const createAllowanceExtensionClient = (
  fundKey,
  { request = lnbitsRequest, sleep = defaultSleep } = {},
) => {
  if (typeof fundKey !== 'string' || fundKey.length === 0) {
    throw new Error(`${FUND_KEY_ENV} is not configured`);
  }

  const fundRequest = async (path, { method = 'GET', body, retry } = {}) => {
    if (!isFundKeyPathAllowed(method, path)) {
      // A programming error, never a runtime condition: fail before the key
      // leaves the process.
      throw new FundKeyPathError(`refusing to send the Fund key to ${method} ${path}`);
    }
    // A create is retried only on 429 (not processed). Retrying it after a
    // 5xx could create a second schedule if the first had been stored.
    const retryable = retry ?? (method === 'POST' ? new Set([429]) : RETRY_STATUSES);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await request(path, {
          method,
          walletKey: fundKey,
          readErrorDetail: true,
          ...(body === undefined ? {} : { body }),
        });
      } catch (error) {
        if (error && typeof error.message === 'string') {
          error.message = maskKeys(error.message);
        }
        if (attempt >= MAX_ATTEMPTS || !retryable.has(error?.upstreamStatus)) {
          throw error;
        }
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  };

  return {
    /** Every allowance on the Fund wallet's LNbits account, active or not. */
    listAllowances: async () => {
      const rows = await fundRequest('/allowance/api/v1/allowance');
      if (!Array.isArray(rows)) {
        throw new Error('allowance list response is malformed');
      }
      return rows;
    },
    getAllowance: async (id) =>
      fundRequest(`/allowance/api/v1/allowance/${requireAllowanceId(id)}`),
    createAllowance: async (body) =>
      fundRequest('/allowance/api/v1/allowance', { method: 'POST', body }),
    updateAllowance: async (id, revision, patch) =>
      fundRequest(`/allowance/api/v1/allowance/${requireAllowanceId(id)}`, {
        method: 'PUT',
        body: { ...patch, revision },
      }),
    deleteAllowance: async (id) =>
      fundRequest(`/allowance/api/v1/allowance/${requireAllowanceId(id)}`, {
        method: 'DELETE',
      }),
    health: () => fundRequest('/allowance/api/v1/health'),
    /** The Fund wallet's id, name and balance in sats. Never its keys. */
    fundWallet: async () => {
      const wallet = await fundRequest(WALLET_READ_PATH);
      const balanceMsat = Number(wallet?.balance);
      return {
        id: typeof wallet?.id === 'string' ? wallet.id : null,
        name: typeof wallet?.name === 'string' ? wallet.name : '',
        balanceSats: Number.isFinite(balanceMsat) ? Math.floor(balanceMsat / 1000) : null,
      };
    },
  };
};

module.exports = {
  FUND_KEY_ENV,
  FundKeyPathError,
  createAllowanceExtensionClient,
  isFundKeyPathAllowed,
  readFundKeys,
};
