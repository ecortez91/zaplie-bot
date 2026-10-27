const test = require('node:test');
const assert = require('node:assert/strict');
const { rewardPeriodKey } = require('./rewardPeriod');

// Same cases as the bot's src/services/rewardPeriod.test.ts: the two twins
// must agree on which period an instant falls in.
const cases = [
  ['2026-10-29T12:00:00Z', 'week', 'UTC', 'week:2026-W44'],
  ['2025-12-29T12:00:00Z', 'week', 'UTC', 'week:2026-W01'],
  ['2027-01-01T12:00:00Z', 'week', 'UTC', 'week:2026-W53'],
  ['2026-11-01T23:30:00Z', 'week', 'Europe/London', 'week:2026-W44'],
  ['2026-11-02T00:00:00Z', 'week', 'Europe/London', 'week:2026-W45'],
  ['2026-06-07T23:00:00Z', 'week', 'Europe/London', 'week:2026-W24'],
  ['2026-10-31T23:30:00Z', 'month', 'Europe/London', 'month:2026-10'],
  ['2026-10-31T23:30:00Z', 'month', 'Asia/Tokyo', 'month:2026-11'],
];

for (const [iso, period, timezone, expected] of cases) {
  test(`${iso} in ${timezone} is ${expected}`, () => {
    assert.equal(rewardPeriodKey(Date.parse(iso), period, timezone), expected);
  });
}
