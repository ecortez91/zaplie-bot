const express = require('express');
const defaultService = require('./lnbitsGatewayService');
const {
  extractBearerToken: defaultExtractBearerToken,
  verifyMsalPayload: defaultVerifyMsalPayload,
} = require('./msalValidator');
const { positiveIntFromEnv } = require('./rewardAmounts');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const INVOICE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const BOLT11_PATTERN = /^ln[a-z0-9]+$/i;

const validId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// Zaps and self-issued invoices have their own ceiling. REWARDS_MAX_AMOUNT_SATS
// is the automated-reward cap (default 10000) and reusing it here silently gave
// this route a 1,000,000 default that no operator had asked for.
const DEFAULT_ZAP_MAX_AMOUNT_SATS = 1_000_000;

// Precedence: ZAP_MAX_AMOUNT_SATS, else whatever REWARDS_MAX_AMOUNT_SATS is set
// to, else 1,000,000. The middle step is what stops this separation from being
// a silent loosening: env/.env.dev.example ships REWARDS_MAX_AMOUNT_SATS=10000,
// so a deployment following the repo's own template keeps its 10,000-sat zap
// ceiling until an operator names a different one. Both are read through the
// reward parser, so a malformed value throws rather than falling back and
// widening the cap the operator meant to tighten.
const zapMaxAmountSats = () => {
  const configuredZapCap = positiveIntFromEnv('ZAP_MAX_AMOUNT_SATS', null);
  if (configuredZapCap !== null) {
    return configuredZapCap;
  }
  return (
    positiveIntFromEnv('REWARDS_MAX_AMOUNT_SATS', null) ??
    DEFAULT_ZAP_MAX_AMOUNT_SATS
  );
};

// Only a real JSON number is an amount. `Number()` would turn `true` into 1 and
// `['5']` into 5, which are not integer amount inputs.
const parseAmount = (value, max = zapMaxAmountSats()) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return value > 0 && value <= max ? value : null;
};

// Pagination is validated, never clamped: a caller-supplied `10.5` or `1e3` is a
// bad request, not something to silently round into an LNbits query.
const parseBoundedInt = (value, { fallback, min, max }) => {
  if (value === undefined) {
    return fallback;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\+?\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
};

const parseMemo = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 500
    ? value.trim()
    : null;

const createLnbitsRouter = ({
  service = defaultService,
  extractBearerToken = defaultExtractBearerToken,
  verifyMsalPayload = defaultVerifyMsalPayload,
} = {}) => {
  // Read once, at startup: a malformed cap refuses to start the backend rather
  // than letting it serve requests under a ceiling nobody chose.
  const maxAmountSats = zapMaxAmountSats();
  const router = express.Router();

  router.use(async (req, res, next) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'missing credentials' });
      return;
    }
    try {
      const claims = await verifyMsalPayload(token);
      if (!claims || typeof claims.oid !== 'string' || claims.oid.length === 0) {
        throw new Error('token is missing the oid claim');
      }
      req.auth = { oid: claims.oid, roles: claims.roles || [] };
      next();
    } catch (error) {
      console.error('LNbits gateway token validation failed:', error.message);
      res.status(401).json({ error: 'invalid token' });
    }
  });

  router.use(async (req, _res, next) => {
    try {
      await service.assertCaller(req.auth.oid);
      next();
    } catch (error) {
      next(error);
    }
  });

  // Directory, feed, leaderboard, rewards and per-wallet payment history are
  // intentionally tenant-visible. Every other wallet route resolves the wallet
  // through the caller's own LNbits user, so a wallet id alone grants nothing.

  const asyncRoute = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };

  router.get('/users', asyncRoute(async (_req, res) => {
    res.json(await service.listUsers());
  }));

  router.get('/users/:userId/wallets', asyncRoute(async (req, res) => {
    if (!validId(req.params.userId)) {
      res.status(400).json({ error: 'invalid user id' });
      return;
    }
    res.json(await service.listUserWallets(req.params.userId));
  }));

  router.get('/wallets', asyncRoute(async (_req, res) => {
    res.json(await service.listAllWallets());
  }));

  router.get('/wallets/:walletId', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletDetails(req.params.walletId, req.auth.oid));
  }));

  router.get('/wallets/:walletId/balance', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json({
      balance: await service.getWalletBalance(req.params.walletId, req.auth.oid),
    });
  }));

  router.get('/wallets/:walletId/payments', asyncRoute(async (req, res) => {
    const limit = parseBoundedInt(req.query.limit, {
      fallback: 100,
      min: 1,
      max: 1000,
    });
    if (!validId(req.params.walletId) || limit === null) {
      res.status(400).json({ error: 'invalid payment history request' });
      return;
    }
    res.json(await service.listWalletPayments(req.params.walletId, limit));
  }));

  router.get('/wallets/:walletId/payments/:invoiceId', asyncRoute(async (req, res) => {
    if (
      !validId(req.params.walletId) ||
      !INVOICE_PATTERN.test(req.params.invoiceId)
    ) {
      res.status(400).json({ error: 'invalid wallet or invoice id' });
      return;
    }
    res.json(
      await service.getInvoicePayment(
        req.params.walletId,
        req.params.invoiceId,
        req.auth.oid,
      ),
    );
  }));

  router.get('/wallets/:walletId/paylinks', asyncRoute(async (req, res) => {
    if (!validId(req.params.walletId)) {
      res.status(400).json({ error: 'invalid wallet id' });
      return;
    }
    res.json(await service.getWalletPayLinks(req.params.walletId, req.auth.oid));
  }));

  router.post('/wallets/:walletId/invoices', asyncRoute(async (req, res) => {
    const amount = parseAmount(req.body?.amount, maxAmountSats);
    const memo = parseMemo(req.body?.memo);
    if (!validId(req.params.walletId) || amount === null || memo === null) {
      res.status(400).json({ error: 'invalid invoice request' });
      return;
    }
    const paymentRequest = await service.createOwnedInvoice({
      walletId: req.params.walletId,
      amount,
      memo,
      aadObjectId: req.auth.oid,
    });
    res.status(201).json({ paymentRequest });
  }));

  router.post('/wallets/:walletId/payments', asyncRoute(async (req, res) => {
    const paymentRequest = req.body?.paymentRequest;
    if (
      !validId(req.params.walletId) ||
      typeof paymentRequest !== 'string' ||
      paymentRequest.length > 4096 ||
      !BOLT11_PATTERN.test(paymentRequest)
    ) {
      res.status(400).json({ error: 'invalid payment request' });
      return;
    }
    res.json(
      await service.payOwnedInvoice({
        walletId: req.params.walletId,
        paymentRequest,
        aadObjectId: req.auth.oid,
      }),
    );
  }));

  router.post('/zaps', asyncRoute(async (req, res) => {
    const amount = parseAmount(req.body?.amount, maxAmountSats);
    const memo = parseMemo(req.body?.memo);
    if (!validId(req.body?.recipientUserId) || amount === null || memo === null) {
      res.status(400).json({ error: 'invalid zap request' });
      return;
    }
    res.json(
      await service.sendZap({
        recipientUserId: req.body.recipientUserId,
        amount,
        memo,
        aadObjectId: req.auth.oid,
      }),
    );
  }));

  router.get('/rewards/:stallId', asyncRoute(async (req, res) => {
    if (!validId(req.params.stallId)) {
      res.status(400).json({ error: 'invalid stall id' });
      return;
    }
    res.json(await service.getNostrRewards(req.params.stallId));
  }));

  router.get('/payments', asyncRoute(async (req, res) => {
    const limit = parseBoundedInt(req.query.limit, {
      fallback: 1000,
      min: 1,
      max: 10000,
    });
    const offset = parseBoundedInt(req.query.offset, {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    });
    if (limit === null || offset === null) {
      res.status(400).json({ error: 'invalid pagination request' });
      return;
    }
    res.json(
      await service.getAllPayments({
        limit,
        offset,
        sortby: req.query.sortby,
        direction: req.query.direction,
      }),
    );
  }));

  router.use((error, _req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 502;
    console.error('LNbits gateway request failed:', error.message);
    res.status(status).json({
      error: status >= 500 ? 'LNbits service is unavailable' : error.message,
    });
  });

  return router;
};

module.exports = createLnbitsRouter();
module.exports.createLnbitsRouter = createLnbitsRouter;
module.exports.parseAmount = parseAmount;
