// filepath: tabs/backend/lnbitsAdmin.js
// Server-side LNbits access shared by routes that aggregate or move funds.
// Admin credentials never reach the browser.

// Re-exported so LNbits call sites keep importing their timeout from the module
// that owns the raw fetches, while the value itself lives in one place.
const { REQUEST_TIMEOUT_MS } = require('./httpTimeout');

const requireLnbitsConfig = () => {
  const nodeUrl = process.env.LNBITS_NODE_URL;
  const username = process.env.LNBITS_USERNAME;
  const password = process.env.LNBITS_PASSWORD;
  if (!nodeUrl || !username || !password) {
    throw new Error('LNBITS_NODE_URL, LNBITS_USERNAME and LNBITS_PASSWORD must be set');
  }
  return { nodeUrl, username, password };
};

const getLnbitsToken = async ({ nodeUrl, username, password }) => {
  const response = await fetch(`${nodeUrl}/api/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`LNbits auth failed (status: ${response.status})`);
  }
  const data = await response.json();
  if (!data.access_token) {
    throw new Error('LNbits auth response missing access_token');
  }
  return data.access_token;
};

const lnbitsGet = async (url, accessToken) => {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`LNbits request failed (status: ${response.status}): ${url}`);
  }
  return response.json();
};

module.exports = {
  REQUEST_TIMEOUT_MS,
  requireLnbitsConfig,
  getLnbitsToken,
  lnbitsGet,
};
