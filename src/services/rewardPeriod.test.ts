import { describe, expect, test } from '@jest/globals';
import { periodStartMs, rewardPeriodKey } from './rewardPeriod';

const at = (iso: string): number => Date.parse(iso);

describe('rewardPeriodKey', () => {
  test.each([
    // A Thursday in late October.
    ['2026-10-29T12:00:00Z', 'week:2026-W44'],
    // ISO week 1 of 2026 starts on Monday 29 December 2025.
    ['2025-12-29T12:00:00Z', 'week:2026-W01'],
    // 1 January 2027 is a Friday, so it belongs to 2026-W53.
    ['2027-01-01T12:00:00Z', 'week:2026-W53'],
    ['2027-01-04T12:00:00Z', 'week:2027-W01'],
  ])('%s is in %s', (iso, expected) => {
    expect(rewardPeriodKey(at(iso), 'week', 'UTC')).toBe(expected);
  });

  test('the week rolls over at local midnight on Monday, not UTC', () => {
    // Sunday 1 Nov 2026 23:30 in London (GMT, UTC+0 after the clocks change).
    expect(
      rewardPeriodKey(at('2026-11-01T23:30:00Z'), 'week', 'Europe/London'),
    ).toBe('week:2026-W44');
    expect(
      rewardPeriodKey(at('2026-11-02T00:00:00Z'), 'week', 'Europe/London'),
    ).toBe('week:2026-W45');
    // The same instant is already Monday in Tokyo (UTC+9).
    expect(
      rewardPeriodKey(at('2026-11-01T15:30:00Z'), 'week', 'Asia/Tokyo'),
    ).toBe('week:2026-W45');
  });

  test('a London week during summer time rolls over at 23:00 UTC', () => {
    // Monday 8 June 2026 begins at 00:00 BST, which is 23:00 UTC on Sunday.
    expect(
      rewardPeriodKey(at('2026-06-07T22:59:00Z'), 'week', 'Europe/London'),
    ).toBe('week:2026-W23');
    expect(
      rewardPeriodKey(at('2026-06-07T23:00:00Z'), 'week', 'Europe/London'),
    ).toBe('week:2026-W24');
  });

  test('months follow the local calendar', () => {
    expect(
      rewardPeriodKey(at('2026-10-31T23:30:00Z'), 'month', 'Europe/London'),
    ).toBe('month:2026-10');
    expect(
      rewardPeriodKey(at('2026-10-31T23:30:00Z'), 'month', 'Asia/Tokyo'),
    ).toBe('month:2026-11');
  });

  test('an unknown time zone throws', () => {
    expect(() => rewardPeriodKey(Date.now(), 'week', 'Mars/Base')).toThrow(
      RangeError,
    );
  });
});

describe('periodStartMs', () => {
  test('a month starts on its first day', () => {
    expect(periodStartMs('month:2026-10')).toBe(at('2026-10-01T00:00:00Z'));
  });

  test('an ISO week starts on its Monday', () => {
    expect(periodStartMs('week:2026-W44')).toBe(at('2026-10-26T00:00:00Z'));
    expect(periodStartMs('week:2026-W01')).toBe(at('2025-12-29T00:00:00Z'));
  });

  test('anything else is NaN', () => {
    expect(periodStartMs('day:2026-10-01')).toBeNaN();
  });
});
