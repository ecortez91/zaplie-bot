// The period budget in force, resolved exactly as the bot resolves it in
// src/services/rewardBudget.ts (resolveBudget and getRewardBudget): each
// REWARDS_BUDGET_* variable that is set wins over the portal's value for that
// field, and the portal store is not read at all when all three are set.
// Separate package, same rules. Change both.
const { readRewardPolicy } = require('./rewardPolicy');

const ENV_PERIOD = 'REWARDS_BUDGET_PERIOD';
const ENV_CAP = 'REWARDS_BUDGET_CAP_SATS';
const ENV_TIMEZONE = 'REWARDS_BUDGET_TIMEZONE';

class RewardBudgetConfigError extends Error {}

// Whitespace-only is unset, as in the bot.
const envValue = (environment, name) => {
  const value = environment[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

const isAmount = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * @param portal the portal's validated budget, or null
 * @returns the budget in force, or null when no complete budget is configured
 *   anywhere (the bot then refuses to pay)
 * @throws RewardBudgetConfigError when an environment value is malformed (the
 *   bot then refuses to pay)
 */
const resolveBudget = (portal, environment = process.env) => {
  const envPeriod = envValue(environment, ENV_PERIOD);
  if (envPeriod !== undefined && envPeriod !== 'week' && envPeriod !== 'month') {
    throw new RewardBudgetConfigError(`${ENV_PERIOD} must be week or month`);
  }
  const envCap = envValue(environment, ENV_CAP);
  let cap;
  if (envCap !== undefined) {
    cap = /^\d+$/.test(envCap) ? Number.parseInt(envCap, 10) : Number.NaN;
    if (!isAmount(cap)) {
      throw new RewardBudgetConfigError(`${ENV_CAP} must be a positive integer`);
    }
  }
  const envTimezone = envValue(environment, ENV_TIMEZONE);
  if (envTimezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: envTimezone });
    } catch (_error) {
      throw new RewardBudgetConfigError(`${ENV_TIMEZONE} must be an IANA time zone`);
    }
  }

  const period = envPeriod ?? portal?.period;
  const capSats = cap ?? portal?.capSats;
  const timezone = envTimezone ?? portal?.timezone;
  if (period === undefined || capSats === undefined || timezone === undefined) {
    return null;
  }
  return { period, capSats, timezone };
};

/**
 * The budget the bot enforces for its next reward.
 *
 * @param loadData returns the parsed data.json; called only when the
 *   environment does not set all three fields, as the bot only then reads the
 *   portal
 * @returns the budget, or null when none is configured
 * @throws when the environment is malformed or the store the bot would read is
 *   invalid: in both cases the bot pays nothing
 */
const readEffectiveBudget = (loadData, environment = process.env) => {
  if (
    envValue(environment, ENV_PERIOD) !== undefined &&
    envValue(environment, ENV_CAP) !== undefined &&
    envValue(environment, ENV_TIMEZONE) !== undefined
  ) {
    return resolveBudget(null, environment);
  }
  return resolveBudget(readRewardPolicy(loadData()).rewardPolicy.budget, environment);
};

module.exports = {
  RewardBudgetConfigError,
  readEffectiveBudget,
  resolveBudget,
};
