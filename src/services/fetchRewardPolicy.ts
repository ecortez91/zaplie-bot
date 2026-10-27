import { tabBackendApiUrl, tabBackendAuthHeader } from './internalAuth';

// Same rules as tabs/backend/rewardPolicy.js. The bot re-checks instead of
// trusting the response: whatever comes back here decides how many sats leave
// the treasury. Separate packages, so the rules are repeated. Change both.

export type RewardPolicyEventType =
  'githubPrMerged' | 'githubIssueClosed' | 'githubReviewSubmitted';

const EVENT_TYPES: readonly RewardPolicyEventType[] = [
  'githubPrMerged',
  'githubIssueClosed',
  'githubReviewSubmitted',
];
const AMOUNT_KEYS = EVENT_TYPES.map(eventType => `${eventType}Sats`);
const LABEL_PREFIX_PATTERN = /^[A-Za-z0-9:_-]{1,20}$/;
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const OID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LEVELS = 10;
const MAX_BUDGET_SATS = 100_000_000;

export interface LevelRule {
  labelPrefix: string;
  bonuses: Record<string, number>;
}

export interface RewardBudget {
  period: 'week' | 'month';
  capSats: number;
  timezone: string;
}

export interface RewardPolicy {
  version: 1;
  levels: Partial<Record<RewardPolicyEventType, LevelRule>>;
  overrides: Record<
    string,
    Partial<Record<RewardPolicyEventType, { baseSats: number }>>
  >;
  budget: RewardBudget | null;
}

export interface RewardConfig {
  // Only the amounts an admin saved; an absent event pays nothing.
  rewardAmounts: Record<string, number>;
  rewardPolicy: RewardPolicy;
}

export class RewardPolicyInvalidError extends Error {
  constructor(message: string) {
    super(`reward policy response failed validation: ${message}`);
    this.name = 'RewardPolicyInvalidError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isEventType = (value: string): value is RewardPolicyEventType =>
  (EVENT_TYPES as readonly string[]).includes(value);

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RewardPolicyInvalidError(`${where} has unknown key ${key}`);
    }
  }
};

const isValidTimezone = (timezone: unknown): timezone is string => {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const validateAmounts = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) {
    throw new RewardPolicyInvalidError('rewardAmounts is not an object');
  }
  const result: Record<string, number> = {};
  for (const [key, sats] of Object.entries(value)) {
    if (!AMOUNT_KEYS.includes(key)) {
      throw new RewardPolicyInvalidError(`unknown reward amount ${key}`);
    }
    if (!isPositiveInt(sats)) {
      throw new RewardPolicyInvalidError(`${key} is not a positive integer`);
    }
    result[key] = sats;
  }
  return result;
};

const validateLevels = (value: unknown): RewardPolicy['levels'] => {
  if (!isRecord(value)) {
    throw new RewardPolicyInvalidError('levels is not an object');
  }
  const result: RewardPolicy['levels'] = {};
  for (const [eventType, rule] of Object.entries(value)) {
    if (!isEventType(eventType) || !isRecord(rule)) {
      throw new RewardPolicyInvalidError(`levels.${eventType} is invalid`);
    }
    exactKeys(rule, ['labelPrefix', 'bonuses'], `levels.${eventType}`);
    if (
      typeof rule.labelPrefix !== 'string' ||
      !LABEL_PREFIX_PATTERN.test(rule.labelPrefix) ||
      !isRecord(rule.bonuses) ||
      Object.keys(rule.bonuses).length > MAX_LEVELS
    ) {
      throw new RewardPolicyInvalidError(`levels.${eventType} is invalid`);
    }
    const bonuses: Record<string, number> = {};
    for (const [level, sats] of Object.entries(rule.bonuses)) {
      if (!LEVEL_NAME_PATTERN.test(level) || !isPositiveInt(sats)) {
        throw new RewardPolicyInvalidError(
          `levels.${eventType}.bonuses.${level} is invalid`,
        );
      }
      bonuses[level] = sats;
    }
    result[eventType] = { labelPrefix: rule.labelPrefix, bonuses };
  }
  return result;
};

const validateOverrides = (value: unknown): RewardPolicy['overrides'] => {
  if (!isRecord(value)) {
    throw new RewardPolicyInvalidError('overrides is not an object');
  }
  const result: RewardPolicy['overrides'] = {};
  for (const [personAad, perEvent] of Object.entries(value)) {
    if (!OID_PATTERN.test(personAad) || !isRecord(perEvent)) {
      throw new RewardPolicyInvalidError('an override is invalid');
    }
    const events: Partial<Record<RewardPolicyEventType, { baseSats: number }>> =
      {};
    for (const [eventType, override] of Object.entries(perEvent)) {
      if (!isEventType(eventType) || !isRecord(override)) {
        throw new RewardPolicyInvalidError('an override is invalid');
      }
      exactKeys(override, ['baseSats'], 'an override');
      if (!isPositiveInt(override.baseSats)) {
        throw new RewardPolicyInvalidError('an override base is invalid');
      }
      events[eventType] = { baseSats: override.baseSats };
    }
    result[personAad] = events;
  }
  return result;
};

const validateBudget = (value: unknown): RewardBudget | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new RewardPolicyInvalidError('budget is invalid');
  }
  exactKeys(value, ['period', 'capSats', 'timezone'], 'budget');
  if (
    (value.period !== 'week' && value.period !== 'month') ||
    !isPositiveInt(value.capSats) ||
    value.capSats > MAX_BUDGET_SATS ||
    !isValidTimezone(value.timezone)
  ) {
    throw new RewardPolicyInvalidError('budget is invalid');
  }
  return {
    period: value.period,
    capSats: value.capSats,
    timezone: value.timezone,
  };
};

/**
 * Validates the portal's `GET /api/reward-policy` body.
 *
 * @throws RewardPolicyInvalidError on anything malformed; the caller pays
 *   nothing
 */
export const parseRewardConfig = (body: unknown): RewardConfig => {
  if (!isRecord(body) || !isRecord(body.rewardPolicy)) {
    throw new RewardPolicyInvalidError('body is not an object');
  }
  const policy = body.rewardPolicy;
  exactKeys(
    policy,
    ['version', 'levels', 'overrides', 'budget'],
    'rewardPolicy',
  );
  if (policy.version !== 1) {
    throw new RewardPolicyInvalidError('unsupported policy version');
  }
  return {
    rewardAmounts: validateAmounts(body.rewardAmounts),
    rewardPolicy: {
      version: 1,
      levels: validateLevels(policy.levels),
      overrides: validateOverrides(policy.overrides),
      budget: validateBudget(policy.budget),
    },
  };
};

/**
 * The amounts and policy the next reward is paid from. Fetched per reward, not
 * cached: an admin's change applies to the next payment, and rewards are rare.
 *
 * @throws Error when the portal is unreachable or the response is malformed
 */
export async function getRewardConfig(): Promise<RewardConfig> {
  const response = await fetch(`${tabBackendApiUrl()}/reward-policy`, {
    headers: { Authorization: tabBackendAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`reward policy fetch failed: ${response.status}`);
  }
  return parseRewardConfig(await response.json());
}
