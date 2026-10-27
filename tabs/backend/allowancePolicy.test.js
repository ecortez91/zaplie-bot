const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AllowancePolicyError,
  applyAllowancePolicyPatch,
  emptyAllowancePolicy,
  isPolicyActive,
  parseAllowancePolicy,
  payLinkRange,
  readAllowancePolicy,
} = require('./allowancePolicy');
const { nextAnchor, startMatchesAnchor } = require('./allowanceSchedule');

// Test values only: production has no default amount or schedule.
const ENABLED = {
  enabled: true,
  amountSats: 25000,
  period: 'weekly',
  anchorWeekday: 5,
  anchorTime: '09:00',
  timezone: 'Europe/London',
  memo: 'Weekly allowance',
};

test('the default policy is disabled with nothing set, and is not active', () => {
  const policy = readAllowancePolicy({});
  assert.deepEqual(policy, emptyAllowancePolicy());
  assert.equal(policy.enabled, false);
  assert.equal(policy.amountSats, null);
  assert.equal(policy.period, null);
  assert.equal(policy.anchorTime, null);
  assert.equal(isPolicyActive(policy), false);
});

test('a complete enabled policy is accepted and active', () => {
  const policy = parseAllowancePolicy(ENABLED);
  assert.equal(policy.enabled, true);
  assert.equal(policy.anchorWeekday, 5);
  assert.equal(policy.anchorDay, null);
  assert.equal(isPolicyActive(policy), true);
});

test('an enabled policy missing any schedule field is refused (fail closed)', () => {
  for (const field of ['amountSats', 'period', 'anchorWeekday', 'anchorTime', 'timezone']) {
    const policy = { ...ENABLED };
    delete policy[field];
    assert.throws(() => parseAllowancePolicy(policy), AllowancePolicyError, field);
  }
  assert.throws(
    () => parseAllowancePolicy({ ...ENABLED, period: 'monthly' }),
    /anchorDay/,
  );
});

test('a disabled draft may be partly filled in', () => {
  const policy = parseAllowancePolicy({ enabled: false, amountSats: 1000 });
  assert.equal(policy.amountSats, 1000);
  assert.equal(isPolicyActive(policy), false);
});

test('values out of range are refused', () => {
  const bad = [
    { amountSats: 0 },
    { amountSats: 1.5 },
    { amountSats: -1 },
    { amountSats: 100001 },
    { period: 'daily' },
    { anchorWeekday: 7 },
    { anchorTime: '9:00' },
    { anchorTime: '24:00' },
    { timezone: 'Mars/Olympus' },
    { memo: 'x'.repeat(201) },
    { enabled: 'yes' },
    { excludedOids: ['not-an-oid'] },
    { payLink: { minSats: 10 } },
    { payLink: { minSats: 10, maxSats: 5 } },
    { payLink: { minSats: 1, maxSats: 10, commentChars: 800 } },
    { unknownKey: true },
  ];
  for (const patch of bad) {
    assert.throws(
      () => parseAllowancePolicy({ ...ENABLED, ...patch }),
      AllowancePolicyError,
      JSON.stringify(patch),
    );
  }
});

test('the amount cap follows ALLOWANCE_MAX_AMOUNT_SATS', () => {
  assert.throws(
    () => parseAllowancePolicy({ ...ENABLED, amountSats: 600 }, { maxAmountSats: 500 }),
    /up to 500/,
  );
  const previous = process.env.ALLOWANCE_MAX_AMOUNT_SATS;
  process.env.ALLOWANCE_MAX_AMOUNT_SATS = 'abc';
  try {
    assert.throws(() => parseAllowancePolicy(ENABLED), /ALLOWANCE_MAX_AMOUNT_SATS/);
  } finally {
    if (previous === undefined) delete process.env.ALLOWANCE_MAX_AMOUNT_SATS;
    else process.env.ALLOWANCE_MAX_AMOUNT_SATS = previous;
  }
});

test('the hidden "Weekly Allowance cleared" phrase is refused in any case', () => {
  for (const memo of ['Weekly Allowance cleared', 'note: weekly allowance CLEARED!']) {
    assert.throws(() => parseAllowancePolicy({ ...ENABLED, memo }), /hidden/);
  }
});

test('the pay link range must bracket the amount', () => {
  assert.throws(
    () => parseAllowancePolicy({ ...ENABLED, payLink: { minSats: 1, maxSats: 1000 } }),
    /bracket/,
  );
  const policy = parseAllowancePolicy({
    ...ENABLED,
    payLink: { minSats: 1, maxSats: 50000, commentChars: 140 },
  });
  assert.deepEqual(payLinkRange(policy), { minSats: 1, maxSats: 50000, commentChars: 140 });
  assert.deepEqual(payLinkRange(parseAllowancePolicy(ENABLED)), {
    minSats: 25000,
    maxSats: 25000,
    commentChars: 0,
  });
});

test('excluded oids are lower-cased and de-duplicated', () => {
  const oid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const policy = parseAllowancePolicy({ ...ENABLED, excludedOids: [oid, oid.toLowerCase()] });
  assert.deepEqual(policy.excludedOids, [oid.toLowerCase()]);
});

test('a patch sets the audit fields itself and refuses them in the body', () => {
  const next = applyAllowancePolicyPatch(emptyAllowancePolicy(), ENABLED, {
    by: 'admin-oid',
    now: new Date('2026-10-28T10:00:00Z'),
  });
  assert.equal(next.updatedBy, 'admin-oid');
  assert.equal(next.updatedAt, '2026-10-28T10:00:00.000Z');
  assert.throws(
    () => applyAllowancePolicyPatch(next, { updatedBy: 'someone' }),
    /unknown key updatedBy/,
  );
  assert.throws(() => applyAllowancePolicyPatch(next, {}), /at least one/);
});

test('a malformed stored policy throws instead of paying something nobody chose', () => {
  assert.throws(() => readAllowancePolicy({ allowancePolicy: { enabled: true } }));
  assert.throws(() => readAllowancePolicy({ allowancePolicy: 'on' }));
});

test('nextAnchor is the next anchor weekday and time in the zone', () => {
  const policy = parseAllowancePolicy(ENABLED);
  // Wed 28 Oct 2026, London is on GMT (BST ended 25 Oct).
  const next = nextAnchor(policy, new Date('2026-10-28T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-10-30T09:00:00.000Z');
  // Just after the anchor moves to the following week.
  const after = nextAnchor(policy, new Date('2026-10-30T09:00:00Z'));
  assert.equal(after.toISOString(), '2026-11-06T09:00:00.000Z');
  // In summer time the UTC hour shifts.
  const summer = nextAnchor(policy, new Date('2026-07-01T00:00:00Z'));
  assert.equal(summer.toISOString(), '2026-07-03T08:00:00.000Z');
});

test('nextAnchor keeps a lead over now, as the extension requires', () => {
  const policy = parseAllowancePolicy(ENABLED);
  const next = nextAnchor(policy, new Date('2026-10-30T08:58:00Z'));
  assert.equal(next.toISOString(), '2026-11-06T09:00:00.000Z');
});

test('nextAnchor handles a monthly anchor across the year end', () => {
  const policy = parseAllowancePolicy({
    ...ENABLED,
    period: 'monthly',
    anchorDay: 1,
    timezone: 'America/El_Salvador',
  });
  const next = nextAnchor(policy, new Date('2026-12-15T00:00:00Z'));
  assert.equal(next.toISOString(), '2027-01-01T15:00:00.000Z');
});

test('startMatchesAnchor compares the weekday and time, not the date', () => {
  const policy = parseAllowancePolicy(ENABLED);
  assert.equal(startMatchesAnchor('2026-10-30T09:00:00+00:00', policy), true);
  assert.equal(startMatchesAnchor('2027-03-05T09:00:00Z', policy), true);
  assert.equal(startMatchesAnchor('2026-10-30T10:00:00Z', policy), false);
  assert.equal(startMatchesAnchor('2026-10-29T09:00:00Z', policy), false);
  assert.equal(startMatchesAnchor('not a date', policy), false);
});
