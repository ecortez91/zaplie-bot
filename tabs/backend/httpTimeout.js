// One deadline for every outbound request this backend makes — LNbits and
// GitHub alike. A stalled upstream must not pin an Express request open for
// ever, and a single constant keeps the bound from drifting per call site.
const REQUEST_TIMEOUT_MS = 10 * 1000;

const requestTimeoutSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

module.exports = { REQUEST_TIMEOUT_MS, requestTimeoutSignal };
