const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RewardPolicyError,
  applyRewardPolicyPatch,
  emptyPolicy,
  readRewardPolicy,
  validateRewardPolicy,
} = require('./rewardPolicy');

const OID = '11111111-2222-3333-4444-555555555555';
const CAP = 10000;
const levels = {
  githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 250, L2: 500, L3: 1000 } },
};

const withEnv = (name, value, fn) => {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
};

test('an unconfigured store has no amounts, no bonus, no override and no budget', () => {
  assert.deepEqual(readRewardPolicy({}), {
    rewardAmounts: {},
    rewardPolicy: emptyPolicy(),
  });
});

test('stored amounts are returned as saved, with no defaults merged in', () => {
  const { rewardAmounts } = readRewardPolicy({
    rewardAmounts: { githubPrMergedSats: 21, timesheetWeekSats: 800 },
  });
  assert.deepEqual(rewardAmounts, { githubPrMergedSats: 21 });
});

test('a full policy round-trips', () => {
  const policy = {
    version: 1,
    levels,
    overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } },
    budget: { period: 'month', capSats: 200000, timezone: 'Europe/London' },
  };
  assert.deepEqual(
    validateRewardPolicy(policy, { githubPrMergedSats: 1000 }, CAP),
    policy,
  );
});

test('override keys are normalised to lower case', () => {
  const policy = validateRewardPolicy(
    { overrides: { [OID.toUpperCase()]: { githubPrMerged: { baseSats: 5 } } } },
    {},
    CAP,
  );
  assert.deepEqual(Object.keys(policy.overrides), [OID]);
});

const invalid = [
  ['an unknown top-level key', { treasuries: {} }],
  ['an unknown event type in levels', { levels: { coffee: levels.githubPrMerged } }],
  ['a bad label prefix', { levels: { githubPrMerged: { labelPrefix: 'has space', bonuses: {} } } }],
  ['a prefix over 20 characters', { levels: { githubPrMerged: { labelPrefix: 'x'.repeat(21), bonuses: {} } } }],
  ['a zero bonus', { levels: { githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 0 } } } }],
  ['a fractional bonus', { levels: { githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 1.5 } } } }],
  ['a string bonus', { levels: { githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: '250' } } } }],
  ['a bad level name', { levels: { githubPrMerged: { labelPrefix: 'reward:', bonuses: { 'L 1': 5 } } } }],
  [
    'more than 10 levels',
    {
      levels: {
        githubPrMerged: {
          labelPrefix: 'reward:',
          bonuses: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`L${i}`, 1])),
        },
      },
    },
  ],
  ['an unknown key in a level rule', { levels: { githubPrMerged: { ...levels.githubPrMerged, extra: 1 } } }],
  ['an override keyed by a non-GUID', { overrides: { octocat: { githubPrMerged: { baseSats: 5 } } } }],
  ['a zero override', { overrides: { [OID]: { githubPrMerged: { baseSats: 0 } } } }],
  ['an override with an unknown key', { overrides: { [OID]: { githubPrMerged: { baseSats: 5, bonus: 1 } } } }],
  ['a budget period of a day', { budget: { period: 'day', capSats: 5, timezone: 'UTC' } }],
  ['a zero budget', { budget: { period: 'week', capSats: 0, timezone: 'UTC' } }],
  ['an unknown time zone', { budget: { period: 'week', capSats: 5, timezone: 'Mars/Olympus' } }],
  ['a budget with an unknown key', { budget: { period: 'week', capSats: 5, timezone: 'UTC', x: 1 } }],
  ['a wrong version', { version: 2 }],
];

for (const [label, policy] of invalid) {
  test(`refuses ${label}`, () => {
    assert.throws(() => validateRewardPolicy(policy, {}, CAP), RewardPolicyError);
  });
}

test('refuses an org base plus the largest bonus above the cap', () => {
  assert.throws(
    () => validateRewardPolicy({ levels }, { githubPrMergedSats: 9001 }, CAP),
    /the org base \(9001\) plus the largest bonus \(1000\) exceeds the per-reward cap of 10000/,
  );
  // Exactly at the cap is allowed.
  assert.doesNotThrow(() =>
    validateRewardPolicy({ levels }, { githubPrMergedSats: 9000 }, CAP),
  );
});

test('refuses a per-person override plus the largest bonus above the cap', () => {
  assert.throws(
    () =>
      validateRewardPolicy(
        { levels, overrides: { [OID]: { githubPrMerged: { baseSats: 9500 } } } },
        {},
        CAP,
      ),
    /the base for 11111111/,
  );
});

test('refuses a bonus that alone exceeds the cap', () => {
  assert.throws(
    () =>
      validateRewardPolicy(
        { levels: { githubPrMerged: { labelPrefix: 'r:', bonuses: { L1: 10001 } } } },
        {},
        CAP,
      ),
    /a bonus of 10001 exceeds/,
  );
});

test('a stored policy is validated again on read and fails closed', () => {
  assert.throws(() =>
    readRewardPolicy({ rewardPolicy: { levels: { githubPrMerged: { labelPrefix: 'r:', bonuses: { L1: -1 } } } } }),
  );
  assert.throws(() => readRewardPolicy({ rewardAmounts: { githubPrMergedSats: 0 } }));
  assert.throws(() => readRewardPolicy({ rewardAmounts: { coffeeSats: 1 } }));
});

test('a lower REWARDS_MAX_AMOUNT_SATS turns a stored policy invalid on read', () => {
  const data = { rewardAmounts: { githubPrMergedSats: 1000 }, rewardPolicy: { levels } };
  assert.doesNotThrow(() => readRewardPolicy(data));
  withEnv('REWARDS_MAX_AMOUNT_SATS', '1500', () => {
    assert.throws(() => readRewardPolicy(data), /exceeds the per-reward cap of 1500/);
  });
});

test('a patch replaces only the keys it names', () => {
  const current = {
    rewardAmounts: {},
    rewardPolicy: {
      ...emptyPolicy(),
      levels,
      budget: { period: 'week', capSats: 5, timezone: 'UTC' },
    },
  };
  const next = applyRewardPolicyPatch(
    current,
    { overrides: { [OID]: { githubPrMerged: { baseSats: 7 } } } },
    CAP,
  );
  assert.deepEqual(next.levels, levels);
  assert.deepEqual(next.budget, { period: 'week', capSats: 5, timezone: 'UTC' });
  assert.deepEqual(next.overrides, { [OID]: { githubPrMerged: { baseSats: 7 } } });
});

test('an empty or unknown patch is refused', () => {
  const current = { rewardAmounts: {}, rewardPolicy: emptyPolicy() };
  assert.throws(() => applyRewardPolicyPatch(current, {}, CAP), RewardPolicyError);
  assert.throws(() => applyRewardPolicyPatch(current, null, CAP), RewardPolicyError);
  assert.throws(
    () => applyRewardPolicyPatch(current, { version: 1 }, CAP),
    RewardPolicyError,
  );
});
