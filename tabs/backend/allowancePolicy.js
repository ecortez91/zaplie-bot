// Weekly allowance policy: how much every person's Allowance wallet receives
// each period, and when. Stored in data.json under `allowancePolicy`, written
// only by a Zaplie.Admin. The payments themselves are made by the LNbits
// allowance extension (github.com/BenGWeeks/allowance) from the Fund wallet;
// Zaplie only manages the schedules and the pay links they pay into.
//
// Money rule: nothing here has a default amount or schedule. The default
// policy is disabled, and an enabled policy must name its amount, period,
// anchor, time and time zone, or it is refused (fail closed).
const { positiveIntFromEnv } = require('./rewardAmounts');

const POLICY_VERSION = 1;
const PERIODS = new Set(['weekly', 'monthly']);
const POLICY_KEYS = new Set([
  'version',
  'enabled',
  'amountSats',
  'period',
  'anchorWeekday',
  'anchorDay',
  'anchorTime',
  'timezone',
  'memo',
  'payLink',
  'overwriteDrift',
  'excludedOids',
  'updatedAt',
  'updatedBy',
]);
// What an admin may send; the version and the audit fields are the server's.
const PATCH_KEYS = new Set(
  [...POLICY_KEYS].filter(
    (key) => !['version', 'updatedAt', 'updatedBy'].includes(key),
  ),
);
const PAY_LINK_KEYS = new Set(['minSats', 'maxSats', 'commentChars']);
const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_MEMO_LENGTH = 200;
const MAX_EXCLUDED = 1000;
const MAX_COMMENT_CHARS = 799;
const DEFAULT_MAX_AMOUNT_SATS = 100_000;
// Payments whose memo carries this phrase are hidden from stats, the feed,
// reports and the leaderboard (the historical top-up sweeps). An allowance
// memo containing it would vanish from every report.
const HIDDEN_MEMO_PATTERN = /weekly allowance cleared/i;

class AllowancePolicyError extends Error {}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;

const isValidTimezone = (timezone) => {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch (_error) {
    return false;
  }
};

/**
 * The ceiling for one person's allowance per period. Read through the reward
 * parser so a malformed value throws instead of widening the cap.
 */
const maxAllowanceSats = () =>
  positiveIntFromEnv('ALLOWANCE_MAX_AMOUNT_SATS', DEFAULT_MAX_AMOUNT_SATS);

const emptyAllowancePolicy = () => ({
  version: POLICY_VERSION,
  enabled: false,
  amountSats: null,
  period: null,
  anchorWeekday: null,
  anchorDay: null,
  anchorTime: null,
  timezone: null,
  memo: '',
  payLink: { minSats: null, maxSats: null, commentChars: 0 },
  overwriteDrift: false,
  excludedOids: [],
  updatedAt: null,
  updatedBy: null,
});

const onlyKeys = (value, allowed, where) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AllowancePolicyError(`${where}: unknown key ${key}`);
    }
  }
};

const nullable = (value) => (value === undefined ? null : value);

const validateMemo = (memo) => {
  if (memo === undefined || memo === null) {
    return '';
  }
  if (typeof memo !== 'string' || memo.length > MAX_MEMO_LENGTH) {
    throw new AllowancePolicyError(`memo must be text of at most ${MAX_MEMO_LENGTH} characters`);
  }
  if (HIDDEN_MEMO_PATTERN.test(memo)) {
    throw new AllowancePolicyError(
      'memo must not contain "Weekly Allowance cleared": payments with it are hidden from every report',
    );
  }
  return memo.trim();
};

const validatePayLink = (payLink) => {
  if (payLink === undefined || payLink === null) {
    return { minSats: null, maxSats: null, commentChars: 0 };
  }
  if (!isPlainObject(payLink)) {
    throw new AllowancePolicyError('payLink must be an object');
  }
  onlyKeys(payLink, PAY_LINK_KEYS, 'payLink');
  const minSats = nullable(payLink.minSats);
  const maxSats = nullable(payLink.maxSats);
  const commentChars = payLink.commentChars ?? 0;
  if (minSats !== null && !isPositiveInt(minSats)) {
    throw new AllowancePolicyError('payLink.minSats must be a positive integer');
  }
  if (maxSats !== null && !isPositiveInt(maxSats)) {
    throw new AllowancePolicyError('payLink.maxSats must be a positive integer');
  }
  if ((minSats === null) !== (maxSats === null)) {
    throw new AllowancePolicyError('payLink.minSats and payLink.maxSats are set together');
  }
  if (minSats !== null && minSats > maxSats) {
    throw new AllowancePolicyError('payLink.minSats must not exceed payLink.maxSats');
  }
  if (
    !Number.isSafeInteger(commentChars) ||
    commentChars < 0 ||
    commentChars > MAX_COMMENT_CHARS
  ) {
    throw new AllowancePolicyError(`payLink.commentChars must be 0-${MAX_COMMENT_CHARS}`);
  }
  return { minSats, maxSats, commentChars };
};

const validateExcluded = (excludedOids) => {
  if (excludedOids === undefined || excludedOids === null) {
    return [];
  }
  if (!Array.isArray(excludedOids) || excludedOids.length > MAX_EXCLUDED) {
    throw new AllowancePolicyError(`excludedOids must be a list of at most ${MAX_EXCLUDED} ids`);
  }
  const result = new Set();
  for (const oid of excludedOids) {
    if (typeof oid !== 'string' || !OID_PATTERN.test(oid)) {
      throw new AllowancePolicyError(`excludedOids: ${String(oid)} is not an Entra object id`);
    }
    result.add(oid.toLowerCase());
  }
  return [...result].sort();
};

/**
 * Validates a stored or submitted policy. A disabled policy may be partly
 * filled in (an admin drafting it); an enabled one must be complete, within
 * the amount cap, and have a pay link range that brackets the amount.
 *
 * @throws AllowancePolicyError with a message an admin can act on
 */
const parseAllowancePolicy = (policy, { maxAmountSats = maxAllowanceSats() } = {}) => {
  if (!isPlainObject(policy)) {
    throw new AllowancePolicyError('allowancePolicy must be an object');
  }
  onlyKeys(policy, POLICY_KEYS, 'allowancePolicy');
  if (policy.version !== undefined && policy.version !== POLICY_VERSION) {
    throw new AllowancePolicyError(`allowancePolicy.version must be ${POLICY_VERSION}`);
  }
  const enabled = policy.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new AllowancePolicyError('enabled must be true or false');
  }
  const overwriteDrift = policy.overwriteDrift ?? false;
  if (typeof overwriteDrift !== 'boolean') {
    throw new AllowancePolicyError('overwriteDrift must be true or false');
  }

  const amountSats = nullable(policy.amountSats);
  if (amountSats !== null && (!isPositiveInt(amountSats) || amountSats > maxAmountSats)) {
    throw new AllowancePolicyError(
      `amountSats must be a positive integer up to ${maxAmountSats} (ALLOWANCE_MAX_AMOUNT_SATS)`,
    );
  }
  const period = nullable(policy.period);
  if (period !== null && !PERIODS.has(period)) {
    throw new AllowancePolicyError("period must be 'weekly' or 'monthly'");
  }
  const anchorWeekday = nullable(policy.anchorWeekday);
  if (
    anchorWeekday !== null &&
    (!Number.isSafeInteger(anchorWeekday) || anchorWeekday < 0 || anchorWeekday > 6)
  ) {
    throw new AllowancePolicyError('anchorWeekday must be 0 (Sunday) to 6 (Saturday)');
  }
  const anchorDay = nullable(policy.anchorDay);
  if (
    anchorDay !== null &&
    (!Number.isSafeInteger(anchorDay) || anchorDay < 1 || anchorDay > 28)
  ) {
    throw new AllowancePolicyError('anchorDay must be 1 to 28');
  }
  const anchorTime = nullable(policy.anchorTime);
  if (anchorTime !== null && (typeof anchorTime !== 'string' || !TIME_PATTERN.test(anchorTime))) {
    throw new AllowancePolicyError("anchorTime must be 'HH:mm' (24-hour)");
  }
  const timezone = nullable(policy.timezone);
  if (timezone !== null && !isValidTimezone(timezone)) {
    throw new AllowancePolicyError('timezone must be an IANA time zone');
  }
  const memo = validateMemo(policy.memo);
  const payLink = validatePayLink(policy.payLink);
  const excludedOids = validateExcluded(policy.excludedOids);
  const updatedAt = nullable(policy.updatedAt);
  const updatedBy = nullable(policy.updatedBy);
  if (updatedAt !== null && typeof updatedAt !== 'string') {
    throw new AllowancePolicyError('updatedAt must be text');
  }
  if (updatedBy !== null && typeof updatedBy !== 'string') {
    throw new AllowancePolicyError('updatedBy must be text');
  }

  const result = {
    version: POLICY_VERSION,
    enabled,
    amountSats,
    period,
    anchorWeekday: period === 'weekly' ? anchorWeekday : null,
    anchorDay: period === 'monthly' ? anchorDay : null,
    anchorTime,
    timezone,
    memo,
    payLink,
    overwriteDrift,
    excludedOids,
    updatedAt,
    updatedBy,
  };

  if (enabled) {
    const missing = [];
    if (amountSats === null) missing.push('amountSats');
    if (period === null) missing.push('period');
    if (period === 'weekly' && anchorWeekday === null) missing.push('anchorWeekday');
    if (period === 'monthly' && anchorDay === null) missing.push('anchorDay');
    if (anchorTime === null) missing.push('anchorTime');
    if (timezone === null) missing.push('timezone');
    if (missing.length > 0) {
      throw new AllowancePolicyError(
        `an enabled allowance policy needs ${missing.join(', ')}`,
      );
    }
    const { minSats, maxSats } = payLink;
    if (minSats !== null && (amountSats < minSats || amountSats > maxSats)) {
      throw new AllowancePolicyError(
        'payLink.minSats and payLink.maxSats must bracket amountSats',
      );
    }
  }
  return result;
};

/**
 * The stored policy, validated on every read so a hand-edited data.json fails
 * closed. Absent means the default: disabled, nothing set.
 *
 * @throws AllowancePolicyError when the stored policy is malformed
 */
const readAllowancePolicy = (data, options) =>
  data?.allowancePolicy === undefined
    ? emptyAllowancePolicy()
    : parseAllowancePolicy(data.allowancePolicy, options);

/**
 * True only when a sync may create or reactivate schedules: enabled, with an
 * amount. Everything else pauses Zaplie's schedules and creates nothing.
 */
const isPolicyActive = (policy) =>
  Boolean(policy && policy.enabled === true && isPositiveInt(policy.amountSats));

/**
 * An admin's patch: each supplied key replaces the stored one. The audit
 * fields are set here, never taken from the body.
 *
 * @throws AllowancePolicyError for an invalid patch (a 400)
 */
const applyAllowancePolicyPatch = (current, patch, { by, now = new Date() } = {}) => {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new AllowancePolicyError('send at least one policy field');
  }
  onlyKeys(patch, PATCH_KEYS, 'allowancePolicy');
  return parseAllowancePolicy({
    ...current,
    ...patch,
    updatedAt: now.toISOString(),
    updatedBy: typeof by === 'string' && by.length > 0 ? by.slice(0, 64) : null,
  });
};

/** The amount every pay link must accept: the policy's range, else exactly the amount. */
const payLinkRange = (policy) => ({
  minSats: policy.payLink.minSats ?? policy.amountSats,
  maxSats: policy.payLink.maxSats ?? policy.amountSats,
  commentChars: policy.payLink.commentChars,
});

module.exports = {
  AllowancePolicyError,
  HIDDEN_MEMO_PATTERN,
  POLICY_VERSION,
  applyAllowancePolicyPatch,
  emptyAllowancePolicy,
  isPolicyActive,
  isValidTimezone,
  maxAllowanceSats,
  parseAllowancePolicy,
  payLinkRange,
  readAllowancePolicy,
};
