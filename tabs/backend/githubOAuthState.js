// filepath: tabs/backend/githubOAuthState.js
// Signed state ties the GitHub callback back to the oid that started the flow,
// so a forged callback can't link a GitHub account to someone else's person.
const crypto = require('crypto');
const { getOrCreateSecret } = require('./secretsStore');

const STATE_TTL_MS = 5 * 60 * 1000; // time to complete the GitHub authorize round trip

const secret = () => getOrCreateSecret('IDENTITY_STATE_SECRET');

const sign = (payload) =>
  crypto.createHmac('sha256', secret()).update(payload).digest('hex');

const signState = (oid) => {
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = `${oid}|${expiry}`;
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
};

const verifyState = (state) => {
  let decoded;
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('|');
  if (parts.length !== 3) {
    return null;
  }
  const [oid, expiryStr, signature] = parts;
  const expectedBuf = Buffer.from(sign(`${oid}|${expiryStr}`), 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');
  if (
    expectedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return null;
  }
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  return oid;
};

// State for the install-ownership check: binds the oid to the installation id
// GitHub reported, so the verify callback checks exactly that pair. The
// leading purpose tag and the different part count keep it from passing
// verifyState, and a plain state from passing this, in either direction.
const INSTALL_PURPOSE = 'install-verify';

const signInstallState = (oid, installationId) => {
  const nonce = crypto.randomBytes(8).toString('hex');
  const expiry = Date.now() + STATE_TTL_MS;
  const payload = [INSTALL_PURPOSE, oid, installationId, nonce, expiry].join('|');
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
};

const verifyInstallState = (state) => {
  if (typeof state !== 'string') {
    return null;
  }
  const parts = Buffer.from(state, 'base64url').toString('utf8').split('|');
  if (parts.length !== 6 || parts[0] !== INSTALL_PURPOSE) {
    return null;
  }
  const signature = parts.pop();
  const expectedBuf = Buffer.from(sign(parts.join('|')), 'hex');
  const signatureBuf = Buffer.from(signature, 'hex');
  if (
    expectedBuf.length !== signatureBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, signatureBuf)
  ) {
    return null;
  }
  const [, oid, installationId, , expiryStr] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) {
    return null;
  }
  return { oid, installationId };
};

module.exports = {
  signState,
  verifyState,
  signInstallState,
  verifyInstallState,
};
