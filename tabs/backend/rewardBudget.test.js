// The stats panel's "spent this period" must use the budget the bot enforces,
// so these cases mirror src/services/rewardBudget.test.ts in the bot.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  RewardBudgetConfigError,
  readEffectiveBudget,
  resolveBudget,
} = require('./rewardBudget');

const PORTAL_BUDGET = { period: 'week', capSats: 50000, timezone: 'Europe/London' };
const storeWith = (budget) => () => ({
  rewardName: 'sats',
  rewardPolicy: { version: 1, levels: {}, overrides: {}, budget },
});

test('with no REWARDS_BUDGET_* set, the portal budget is in force', () => {
  assert.deepEqual(readEffectiveBudget(storeWith(PORTAL_BUDGET), {}), PORTAL_BUDGET);
});

test('each REWARDS_BUDGET_* variable that is set wins over the portal field', () => {
  assert.deepEqual(
    readEffectiveBudget(storeWith(PORTAL_BUDGET), { REWARDS_BUDGET_CAP_SATS: '20000' }),
    { period: 'week', capSats: 20000, timezone: 'Europe/London' },
  );
  assert.deepEqual(
    readEffectiveBudget(storeWith(PORTAL_BUDGET), {
      REWARDS_BUDGET_PERIOD: 'month',
      REWARDS_BUDGET_TIMEZONE: 'UTC',
    }),
    { period: 'month', capSats: 50000, timezone: 'UTC' },
  );
});

test('with all three set, the portal store is not read, as in the bot', () => {
  const env = {
    REWARDS_BUDGET_PERIOD: 'month',
    REWARDS_BUDGET_CAP_SATS: ' 100000 ',
    REWARDS_BUDGET_TIMEZONE: 'UTC',
  };
  const unreadable = () => {
    throw new Error('store must not be read');
  };
  assert.deepEqual(readEffectiveBudget(unreadable, env), {
    period: 'month',
    capSats: 100000,
    timezone: 'UTC',
  });
});

test('whitespace-only variables are unset', () => {
  assert.deepEqual(
    readEffectiveBudget(storeWith(PORTAL_BUDGET), { REWARDS_BUDGET_CAP_SATS: '   ' }),
    PORTAL_BUDGET,
  );
});

test('an incomplete budget is no budget: the bot refuses to pay', () => {
  assert.equal(readEffectiveBudget(storeWith(null), {}), null);
  assert.equal(
    readEffectiveBudget(storeWith(null), { REWARDS_BUDGET_CAP_SATS: '20000' }),
    null,
  );
});

for (const [name, value] of [
  ['REWARDS_BUDGET_PERIOD', 'day'],
  ['REWARDS_BUDGET_CAP_SATS', '1e3'],
  ['REWARDS_BUDGET_CAP_SATS', '0'],
  ['REWARDS_BUDGET_TIMEZONE', 'Mars/Base'],
]) {
  test(`a malformed ${name}=${value} is a config error, as in the bot`, () => {
    assert.throws(() => resolveBudget(PORTAL_BUDGET, { [name]: value }), RewardBudgetConfigError);
  });
}

test('a store the bot would refuse to read is an error, not the portal budget', () => {
  const overCap = () => ({
    rewardName: 'sats',
    rewardAmounts: { githubPrMergedSats: 10_000_000 },
    rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: PORTAL_BUDGET },
  });
  assert.throws(() => readEffectiveBudget(overCap, {}));
});
