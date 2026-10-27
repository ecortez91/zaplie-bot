// Reward policy: per-event level bonuses, per-person base overrides and the
// period budget. Stored in data.json under `rewardPolicy`, written only by a
// Zaplie.Admin, read by the bot once per reward.
//
// Money rule: nothing here has a default amount. An empty policy pays no
// bonus, overrides nobody and sets no budget; the bot refuses to pay without a
// budget and without a configured base (fail closed). Every sats value is a
// positive integer an admin typed.
//
// The bot repeats these checks in src/services/fetchRewardPolicy.ts (separate
// package, same rules). Change both.
const {
  DEFAULT_REWARD_AMOUNTS,
  maxRewardSats,
  migrateRewardAmounts,
} = require('./rewardAmounts');

const POLICY_VERSION = 1;
// Event types a policy may name: the same set the reward amounts allow.
const EVENT_TYPES = Object.freeze(
  Object.keys(DEFAULT_REWARD_AMOUNTS).map((key) => key.replace(/Sats$/, '')),
);
const POLICY_KEYS = new Set(['levels', 'overrides', 'budget']);
const LEVEL_RULE_KEYS = new Set(['labelPrefix', 'bonuses']);
const OVERRIDE_KEYS = new Set(['baseSats']);
const BUDGET_KEYS = new Set(['period', 'capSats', 'timezone']);
const BUDGET_PERIODS = new Set(['week', 'month']);
const LABEL_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{1,20}$/;
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LEVELS = 10;
const MAX_OVERRIDES = 500;
// A budget can cover many rewards, so its ceiling is not the per-reward cap.
// Still bounded so a typo cannot authorise an absurd period spend.
const MAX_BUDGET_SATS = 100_000_000;

class RewardPolicyError extends Error {}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInt = (value) =>
  Number.isSafeInteger(value) && value > 0;

const onlyKeys = (value, allowed, where) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RewardPolicyError(`${where}: unknown key ${key}`);
    }
  }
};

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

const emptyPolicy = () => ({
  version: POLICY_VERSION,
  levels: {},
  overrides: {},
  budget: null,
});

const validateLevels = (levels) => {
  if (!isPlainObject(levels)) {
    throw new RewardPolicyError('levels must be an object');
  }
  const result = {};
  for (const [eventType, rule] of Object.entries(levels)) {
    if (!EVENT_TYPES.includes(eventType)) {
      throw new RewardPolicyError(`levels: unknown event type ${eventType}`);
    }
    if (!isPlainObject(rule)) {
      throw new RewardPolicyError(`levels.${eventType} must be an object`);
    }
    onlyKeys(rule, LEVEL_RULE_KEYS, `levels.${eventType}`);
    if (
      typeof rule.labelPrefix !== 'string' ||
      !LABEL_PREFIX_PATTERN.test(rule.labelPrefix)
    ) {
      throw new RewardPolicyError(
        `levels.${eventType}.labelPrefix must be 1-20 letters, digits, ':', '_' or '-'`,
      );
    }
    if (!isPlainObject(rule.bonuses)) {
      throw new RewardPolicyError(`levels.${eventType}.bonuses must be an object`);
    }
    const entries = Object.entries(rule.bonuses);
    if (entries.length > MAX_LEVELS) {
      throw new RewardPolicyError(
        `levels.${eventType} has more than ${MAX_LEVELS} levels`,
      );
    }
    const bonuses = {};
    for (const [level, sats] of entries) {
      if (!LEVEL_NAME_PATTERN.test(level)) {
        throw new RewardPolicyError(
          `levels.${eventType}: level name ${level} must be 1-20 letters, digits, '_' or '-'`,
        );
      }
      if (!isPositiveInt(sats)) {
        throw new RewardPolicyError(
          `levels.${eventType}.bonuses.${level} must be a positive integer`,
        );
      }
      bonuses[level] = sats;
    }
    result[eventType] = { labelPrefix: rule.labelPrefix, bonuses };
  }
  return result;
};

const validateOverrides = (overrides) => {
  if (!isPlainObject(overrides)) {
    throw new RewardPolicyError('overrides must be an object');
  }
  const entries = Object.entries(overrides);
  if (entries.length > MAX_OVERRIDES) {
    throw new RewardPolicyError(`overrides has more than ${MAX_OVERRIDES} people`);
  }
  const result = {};
  for (const [personAad, perEvent] of entries) {
    if (!OID_PATTERN.test(personAad)) {
      throw new RewardPolicyError(`overrides: ${personAad} is not an Entra object id`);
    }
    if (!isPlainObject(perEvent)) {
      throw new RewardPolicyError(`overrides.${personAad} must be an object`);
    }
    const events = {};
    for (const [eventType, override] of Object.entries(perEvent)) {
      if (!EVENT_TYPES.includes(eventType)) {
        throw new RewardPolicyError(`overrides: unknown event type ${eventType}`);
      }
      if (!isPlainObject(override)) {
        throw new RewardPolicyError(
          `overrides.${personAad}.${eventType} must be an object`,
        );
      }
      onlyKeys(override, OVERRIDE_KEYS, `overrides.${personAad}.${eventType}`);
      if (!isPositiveInt(override.baseSats)) {
        throw new RewardPolicyError(
          `overrides.${personAad}.${eventType}.baseSats must be a positive integer`,
        );
      }
      events[eventType] = { baseSats: override.baseSats };
    }
    // Lower-cased: Entra returns oids lower-case, and one person must not
    // have two spellings of the same key.
    result[personAad.toLowerCase()] = events;
  }
  return result;
};

const validateBudget = (budget) => {
  if (budget === null) {
    return null;
  }
  if (!isPlainObject(budget)) {
    throw new RewardPolicyError('budget must be an object or null');
  }
  onlyKeys(budget, BUDGET_KEYS, 'budget');
  if (!BUDGET_PERIODS.has(budget.period)) {
    throw new RewardPolicyError("budget.period must be 'week' or 'month'");
  }
  if (!isPositiveInt(budget.capSats) || budget.capSats > MAX_BUDGET_SATS) {
    throw new RewardPolicyError(
      `budget.capSats must be a positive integer up to ${MAX_BUDGET_SATS}`,
    );
  }
  if (!isValidTimezone(budget.timezone)) {
    throw new RewardPolicyError('budget.timezone must be an IANA time zone');
  }
  return {
    period: budget.period,
    capSats: budget.capSats,
    timezone: budget.timezone,
  };
};

// The largest single reward the policy can produce for each event must stay
// within REWARDS_MAX_AMOUNT_SATS: any base (org default or a person's
// override) plus the largest bonus.
const assertWithinCap = (policy, rewardAmounts, cap) => {
  for (const eventType of EVENT_TYPES) {
    const bonuses = Object.values(policy.levels[eventType]?.bonuses || {});
    const maxBonus = bonuses.length ? Math.max(...bonuses) : 0;
    const bases = [];
    const orgBase = rewardAmounts[`${eventType}Sats`];
    if (orgBase !== undefined) {
      bases.push(['the org base', orgBase]);
    }
    for (const [personAad, perEvent] of Object.entries(policy.overrides)) {
      if (perEvent[eventType]) {
        bases.push([`the base for ${personAad}`, perEvent[eventType].baseSats]);
      }
    }
    if (maxBonus > cap) {
      throw new RewardPolicyError(
        `${eventType}: a bonus of ${maxBonus} exceeds the per-reward cap of ${cap}`,
      );
    }
    for (const [label, base] of bases) {
      if (base + maxBonus > cap) {
        throw new RewardPolicyError(
          `${eventType}: ${label} (${base}) plus the largest bonus (${maxBonus}) exceeds the per-reward cap of ${cap}`,
        );
      }
    }
  }
};

/**
 * Validates a whole policy against the per-reward cap.
 *
 * @throws RewardPolicyError with a message an admin can act on
 */
const validateRewardPolicy = (policy, rewardAmounts, cap) => {
  if (!isPlainObject(policy)) {
    throw new RewardPolicyError('rewardPolicy must be an object');
  }
  const { version, ...rest } = policy;
  if (version !== undefined && version !== POLICY_VERSION) {
    throw new RewardPolicyError(`rewardPolicy.version must be ${POLICY_VERSION}`);
  }
  onlyKeys(rest, POLICY_KEYS, 'rewardPolicy');
  const validated = {
    version: POLICY_VERSION,
    levels: validateLevels(rest.levels ?? {}),
    overrides: validateOverrides(rest.overrides ?? {}),
    budget: validateBudget(rest.budget ?? null),
  };
  assertWithinCap(validated, rewardAmounts, cap);
  return validated;
};

/**
 * The reward amounts an admin actually saved, with no defaults merged in: an
 * event nobody configured is absent, and the bot pays nothing for it.
 *
 * @throws Error when the stored value is malformed or above the cap
 */
const readConfiguredRewardAmounts = (data, cap) => {
  const stored = migrateRewardAmounts(data.rewardAmounts);
  for (const [key, value] of Object.entries(stored)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_REWARD_AMOUNTS, key)) {
      throw new RewardPolicyError(`unknown reward rule ${key}`);
    }
    if (!isPositiveInt(value) || value > cap) {
      throw new RewardPolicyError(`${key} must be a positive integer up to ${cap}`);
    }
  }
  return stored;
};

/**
 * The stored policy, validated again on every read so a hand-edited
 * data.json fails closed instead of paying something nobody chose.
 *
 * @throws Error when the stored policy or amounts are malformed
 */
const readRewardPolicy = (data) => {
  const cap = maxRewardSats();
  const rewardAmounts = readConfiguredRewardAmounts(data, cap);
  const rewardPolicy =
    data.rewardPolicy === undefined
      ? emptyPolicy()
      : validateRewardPolicy(data.rewardPolicy, rewardAmounts, cap);
  return { rewardAmounts, rewardPolicy };
};

/**
 * Applies an admin's patch: each supplied top-level key (`levels`,
 * `overrides`, `budget`) replaces the stored one whole.
 *
 * @param current the result of readRewardPolicy (already validated)
 * @returns the next policy to store
 * @throws RewardPolicyError for an invalid patch (a 400)
 */
const applyRewardPolicyPatch = (current, patch, cap) => {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new RewardPolicyError('send at least one of levels, overrides, budget');
  }
  onlyKeys(patch, POLICY_KEYS, 'rewardPolicy');
  const next = { ...current.rewardPolicy, ...patch };
  return validateRewardPolicy(next, current.rewardAmounts, cap);
};

module.exports = {
  EVENT_TYPES,
  POLICY_VERSION,
  RewardPolicyError,
  applyRewardPolicyPatch,
  emptyPolicy,
  readConfiguredRewardAmounts,
  readRewardPolicy,
  validateRewardPolicy,
};
