const {
  getLnbitsToken,
  requireLnbitsConfig,
} = require('./lnbitsAdmin');
const {
  findUniqueUserByAadObjectId,
  parseExtra,
} = require('./lnbitsUserDirectory');
const {
  createZapIdempotencyStore,
} = require('./lnbitsZapIdempotencyStore');

const TOKEN_CACHE_MS = 5 * 60 * 1000;
// A stalled LNbits connection must not pin an Express request open for ever.
const REQUEST_TIMEOUT_MS = 10 * 1000;
const WALLET_CACHE_MS = 30 * 1000;
const SENSITIVE_FIELD = /(adminkey|inkey|admin.?key|invoice.?key|password|preimage|secret|token)/i;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

let tokenCache = null;
const walletCache = new Map();
let walletIndex = null;

class LnbitsGatewayError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'LnbitsGatewayError';
    this.status = status;
  }
}

const requireGatewayConfig = () => ({
  ...requireLnbitsConfig(),
  adminKey: process.env.LNBITS_ADMINKEY || '',
});

const maxZapAmountSats = () => {
  const configured = process.env.REWARDS_MAX_AMOUNT_SATS;
  if (configured === undefined || configured === '') {
    return 1_000_000;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LnbitsGatewayError(
      'REWARDS_MAX_AMOUNT_SATS must be a positive integer',
      503,
    );
  }
  return value;
};

const getAccessToken = async (config) => {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.value;
  }
  const value = await getLnbitsToken(config);
  tokenCache = { value, expiresAt: now + TOKEN_CACHE_MS };
  return value;
};

const safeJson = async (response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new LnbitsGatewayError('LNbits returned a non-JSON response');
  }
  return response.json();
};

const lnbitsRequest = async (path, options = {}) => {
  const config = requireGatewayConfig();
  const headers = {
    accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };

  if (options.walletKey) {
    headers['X-Api-Key'] = options.walletKey;
  } else if (options.adminKey) {
    if (!config.adminKey) {
      throw new LnbitsGatewayError('LNbits admin key is not configured', 503);
    }
    headers['X-Api-Key'] = config.adminKey;
  } else {
    headers.Authorization = `Bearer ${await getAccessToken(config)}`;
  }

  let response;
  try {
    response = await fetch(`${config.nodeUrl}${path}`, {
      method: options.method || 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new LnbitsGatewayError('LNbits request timed out', 502);
    }
    throw error;
  }

  if (!response.ok) {
    if (!options.walletKey && !options.adminKey && response.status === 401) {
      tokenCache = null;
    }
    // Only genuine caller mistakes are propagated. An LNbits 401/403 means the
    // gateway's own credentials failed, which is a 502 for the browser.
    const status =
      response.status === 400 || response.status === 404 ? response.status : 502;
    throw new LnbitsGatewayError(
      `LNbits request failed with status ${response.status}`,
      status,
    );
  }
  return safeJson(response);
};

const redactSensitive = (value, depth = 0) => {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_FIELD.test(key))
      .map(([key, nested]) => [key, redactSensitive(nested, depth + 1)]),
  );
};

const sanitizeUser = (user) => {
  const extra = parseExtra(user);
  let displayName = String(user.username || user.name || user.id || '');
  if (displayName.includes('@')) {
    displayName = displayName
      .split('@')[0]
      .replace('.', ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return {
    id: user.id,
    displayName,
    profileImg: extra.profileImg || '',
    aadObjectId: user.external_id || extra.aadObjectId || '',
    email: user.email || extra.email || user.username || '',
    type: extra.type || 'Teammate',
    privateWallet: null,
    allowanceWallet: null,
  };
};

const sanitizeWallet = (wallet) => ({
  id: wallet.id,
  name: wallet.name,
  user: wallet.user,
  balance_msat: Number(wallet.balance_msat || 0),
  deleted: wallet.deleted === true,
});

const sanitizePayment = (payment) => ({
  checking_id: payment.checking_id || payment.payment_hash || payment.id || '',
  payment_hash: payment.payment_hash,
  // LNbits v1 dropped the boolean `pending` field in favour of `status`;
  // derive it so in-flight payments are not misread as settled.
  pending:
    payment.pending === true ||
    String(payment.status || '').toLowerCase() === 'pending',
  amount: Number(payment.amount || 0),
  fee: Number(payment.fee || 0),
  memo: payment.memo || '',
  time: payment.time,
  extra: redactSensitive(payment.extra || {}),
  wallet_id: payment.wallet_id,
});

const listRawUsers = async () => {
  const body = await lnbitsRequest('/users/api/v1/user');
  const users = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(users)) {
    throw new LnbitsGatewayError('LNbits users response is malformed');
  }
  return users;
};

const listUsers = async () => (await listRawUsers()).map(sanitizeUser);

const cacheWallet = (wallet) => {
  if (wallet?.id && wallet?.inkey && wallet?.adminkey) {
    walletCache.set(wallet.id, {
      wallet,
      expiresAt: Date.now() + WALLET_CACHE_MS,
    });
  }
};

const listUserWalletsWithKeys = async (userId) => {
  const wallets = await lnbitsRequest(
    `/users/api/v1/user/${encodeURIComponent(userId)}/wallet`,
  );
  if (!Array.isArray(wallets)) {
    throw new LnbitsGatewayError('LNbits wallets response is malformed');
  }
  const active = wallets.filter((wallet) => wallet.deleted !== true);
  active.forEach(cacheWallet);
  return active;
};

const listUserWallets = async (userId) =>
  (await listUserWalletsWithKeys(userId)).map(sanitizeWallet);

const buildWalletIndex = async () => {
  const index = new Map();
  for (const user of await listRawUsers()) {
    for (const wallet of await listUserWalletsWithKeys(user.id)) {
      index.set(wallet.id, wallet);
    }
  }
  return index;
};

// The feed reads every teammate's wallet at once, so one shared walk per cache
// window replaces a per-request walk costing an upstream call per user.
const getWalletIndex = () => {
  if (walletIndex && walletIndex.expiresAt > Date.now()) {
    return walletIndex.entries;
  }
  const entry = { expiresAt: Date.now() + WALLET_CACHE_MS };
  entry.entries = buildWalletIndex().catch((error) => {
    if (walletIndex === entry) {
      walletIndex = null;
    }
    throw error;
  });
  walletIndex = entry;
  return entry.entries;
};

const getWalletWithKeys = async (walletId) => {
  const cached = walletCache.get(walletId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.wallet;
  }
  walletCache.delete(walletId);

  const wallet = (await getWalletIndex()).get(walletId);
  if (!wallet) {
    throw new LnbitsGatewayError('Wallet not found', 404);
  }
  return wallet;
};

const listAllWallets = async () => {
  const wallets = [];
  for (const user of await listRawUsers()) {
    wallets.push(...(await listUserWallets(user.id)));
  }
  return wallets;
};

const findCaller = async (aadObjectId) => {
  const user = findUniqueUserByAadObjectId(await listRawUsers(), aadObjectId);
  if (!user) {
    throw new LnbitsGatewayError('No LNbits user is linked to this account', 403);
  }
  return user;
};

const assertCaller = async (aadObjectId) => {
  await findCaller(aadObjectId);
};

const requireOwnedWallet = async (walletId, aadObjectId) => {
  const user = await findCaller(aadObjectId);
  const wallet = (await listUserWalletsWithKeys(user.id)).find(
    (candidate) => candidate.id === walletId,
  );
  if (!wallet) {
    throw new LnbitsGatewayError('Wallet does not belong to this account', 403);
  }
  return wallet;
};

const getWalletDetails = async (walletId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  const details = await lnbitsRequest(`/api/v1/wallets/${encodeURIComponent(walletId)}`, {
    walletKey: wallet.inkey,
  });
  return sanitizeWallet({ ...wallet, ...details });
};

const walletBalanceSats = async (wallet) => {
  const details = await lnbitsRequest('/api/v1/wallet', { walletKey: wallet.inkey });
  return Number(details.balance || 0) / 1000;
};

const getWalletBalance = async (walletId, aadObjectId) =>
  walletBalanceSats(await requireOwnedWallet(walletId, aadObjectId));

// Deliberately tenant-wide: the team feed and the transaction log build their
// history from every teammate's wallet, so this read cannot be owner-only.
const listWalletPayments = async (walletId, limit = 100) => {
  const wallet = await getWalletWithKeys(walletId);
  const payments = await lnbitsRequest(`/api/v1/payments?limit=${limit}`, {
    walletKey: wallet.inkey,
  });
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return payments.map(sanitizePayment);
};

const getInvoicePayment = async (walletId, invoiceId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(`/api/v1/payments/${encodeURIComponent(invoiceId)}`, {
      walletKey: wallet.inkey,
    }),
  );
};

const getWalletPayLinks = async (walletId, aadObjectId) => {
  const wallet = await requireOwnedWallet(walletId, aadObjectId);
  return redactSensitive(
    await lnbitsRequest(
      `/lnurlp/api/v1/links?all_wallets=false&wallet=${encodeURIComponent(walletId)}`,
      { walletKey: wallet.inkey },
    ),
  );
};

const validPaymentId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

const createInvoice = async (wallet, amount, memo) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.inkey,
    body: { out: false, amount, memo },
  });
  const paymentRequest = result.payment_request;
  const invoiceId = validPaymentId(result.checking_id)
    ? result.checking_id
    : result.payment_hash;
  if (
    typeof paymentRequest !== 'string' ||
    paymentRequest.length === 0 ||
    paymentRequest.length > 4096 ||
    !validPaymentId(invoiceId)
  ) {
    throw new LnbitsGatewayError(
      'LNbits did not return a complete invoice',
    );
  }
  return { paymentRequest, invoiceId };
};

const createOwnedInvoice = async ({ walletId, amount, memo, aadObjectId }) =>
  createInvoice(await requireOwnedWallet(walletId, aadObjectId), amount, memo);

const payInvoice = async (wallet, paymentRequest) => {
  const result = await lnbitsRequest('/api/v1/payments', {
    method: 'POST',
    walletKey: wallet.adminkey,
    body: { out: true, bolt11: paymentRequest },
  });
  const paymentId = validPaymentId(result.payment_hash)
    ? result.payment_hash
    : result.checking_id;
  if (!validPaymentId(paymentId)) {
    throw new LnbitsGatewayError(
      'LNbits did not return a payment identifier',
    );
  }
  return {
    payment_hash: validPaymentId(result.payment_hash)
      ? result.payment_hash
      : paymentId,
    checking_id: validPaymentId(result.checking_id)
      ? result.checking_id
      : paymentId,
  };
};

const payOwnedInvoice = async ({ walletId, paymentRequest, aadObjectId }) =>
  payInvoice(await requireOwnedWallet(walletId, aadObjectId), paymentRequest);

const createSendZap = ({
  findCallerForZap = findCaller,
  listWalletsForZap = listUserWalletsWithKeys,
  getBalanceForZap = walletBalanceSats,
  createInvoiceForZap = createInvoice,
  payInvoiceForZap = payInvoice,
  idempotencyStore = createZapIdempotencyStore(),
} = {}) => {
  const inFlight = new Map();

  return async ({
    recipientUserId,
    amount,
    memo,
    aadObjectId,
    idempotencyKey,
  }) => {
    const maxAmount = maxZapAmountSats();
    if (
      !USER_ID_PATTERN.test(recipientUserId || '') ||
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      amount > maxAmount ||
      typeof memo !== 'string' ||
      memo.trim().length === 0 ||
      memo.length > 500 ||
      typeof aadObjectId !== 'string' ||
      aadObjectId.length === 0 ||
      !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey || '')
    ) {
      throw new LnbitsGatewayError('Invalid zap request', 400);
    }

    const scope = idempotencyStore.scopeDigest({
      aadObjectId,
      idempotencyKey,
    });
    const requestHash = idempotencyStore.requestDigest({
      recipientUserId,
      amount,
      memo,
    });
    const active = inFlight.get(scope);
    if (active) {
      if (active.requestHash !== requestHash) {
        throw new LnbitsGatewayError(
          'Idempotency key was already used for another zap',
          409,
        );
      }
      return active.promise;
    }

    const operation = (async () => {
      const sender = await findCallerForZap(aadObjectId);
      if (recipientUserId === sender.id) {
        throw new LnbitsGatewayError('A user cannot zap their own account', 409);
      }

      const idempotency = await idempotencyStore.begin({ scope, requestHash });
      if (idempotency.state === 'replay') {
        return idempotency.result;
      }
      if (idempotency.state === 'pending') {
        throw new LnbitsGatewayError('Zap request is already in progress', 409);
      }
      if (idempotency.state === 'failed') {
        throw new LnbitsGatewayError(
          'Idempotency key cannot be retried safely',
          409,
        );
      }

      let paymentAttempted = false;
      try {
        const senderWallets = await listWalletsForZap(sender.id);
        const senderWallet = senderWallets.find(
          (wallet) => String(wallet.name).trim().toLowerCase() === 'allowance',
        );
        if (!senderWallet) {
          throw new LnbitsGatewayError('Allowance wallet not found', 409);
        }

        const recipientWallets = await listWalletsForZap(recipientUserId);
        const recipientWallet = recipientWallets.find(
          (wallet) => String(wallet.name).trim().toLowerCase() === 'private',
        );
        if (!recipientWallet) {
          throw new LnbitsGatewayError('Recipient private wallet not found', 409);
        }

        const senderBalance = await getBalanceForZap(senderWallet);
        if (!Number.isFinite(senderBalance) || senderBalance < amount) {
          throw new LnbitsGatewayError('Insufficient allowance balance', 409);
        }

        const invoice = await createInvoiceForZap(
          recipientWallet,
          amount,
          memo,
        );
        paymentAttempted = true;
        const result = await payInvoiceForZap(
          senderWallet,
          invoice.paymentRequest,
        );
        try {
          await idempotencyStore.complete({ scope, requestHash, result });
        } catch (persistError) {
          console.error(
            'Zap idempotency completion could not be persisted',
            persistError,
          );
        }
        return result;
      } catch (error) {
        try {
          if (paymentAttempted) {
            await idempotencyStore.fail({ scope, requestHash });
          } else {
            // No payment was attempted, so the key is safe to retry.
            await idempotencyStore.release({ scope, requestHash });
          }
        } catch (persistError) {
          console.error(
            'Zap idempotency outcome could not be persisted',
            persistError,
          );
        }
        throw error;
      }
    })();

    inFlight.set(scope, { requestHash, promise: operation });
    try {
      return await operation;
    } finally {
      if (inFlight.get(scope)?.promise === operation) {
        inFlight.delete(scope);
      }
    }
  };
};

const sendZap = createSendZap();

const getNostrRewards = async (stallId) => {
  const rewards = await lnbitsRequest(
    `/nostrmarket/api/v1/stall/product/${encodeURIComponent(stallId)}`,
    { adminKey: true },
  );
  if (!Array.isArray(rewards)) {
    throw new LnbitsGatewayError('LNbits rewards response is malformed');
  }
  return rewards.map((reward) => ({
    id: reward.id,
    image: reward.image || (Array.isArray(reward.images) ? reward.images[0] : ''),
    name: reward.name,
    shortDescription:
      reward.shortDescription || reward.description || reward.config?.description || '',
    link:
      reward.link ||
      (Array.isArray(reward.categories) ? reward.categories[0] : reward.categories) ||
      '',
    price: Number(reward.price || 0),
  }));
};

const getAllPayments = async ({ limit = 1000, offset = 0, direction = 'desc' }) => {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortby: 'time',
    direction: direction === 'asc' ? direction : 'desc',
  });
  const body = await lnbitsRequest(`/api/v1/payments/all/paginated?${params}`);
  const payments = Array.isArray(body)
    ? body
    : body?.data || body?.payments || body?.items;
  if (!Array.isArray(payments)) {
    throw new LnbitsGatewayError('LNbits payments response is malformed');
  }
  return payments.map(sanitizePayment);
};

const resetCachesForTests = () => {
  tokenCache = null;
  walletCache.clear();
  walletIndex = null;
};

module.exports = {
  LnbitsGatewayError,
  assertCaller,
  createInvoice,
  createSendZap,
  createOwnedInvoice,
  getAllPayments,
  getInvoicePayment,
  getNostrRewards,
  getWalletBalance,
  getWalletDetails,
  getWalletPayLinks,
  listAllWallets,
  listRawUsers,
  listUserWallets,
  listUsers,
  listWalletPayments,
  maxZapAmountSats,
  payOwnedInvoice,
  resetCachesForTests,
  redactSensitive,
  sanitizePayment,
  sanitizeWallet,
  sendZap,
};
