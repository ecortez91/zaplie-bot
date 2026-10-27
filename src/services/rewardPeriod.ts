// Budget periods: an ISO week (Monday to Sunday) or a calendar month, in the
// admin's configured time zone. Intl does the zone arithmetic, so there is no
// new dependency and daylight-saving changes are the platform's problem.

export type BudgetPeriod = 'week' | 'month';

export const PERIOD_KEY_PATTERN =
  /^(week:\d{4}-W(0[1-9]|[1-4]\d|5[0-3])|month:\d{4}-(0[1-9]|1[0-2]))$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar date at `now` in `timezone`.
 *
 * @throws RangeError for an unknown time zone
 */
const localDate = (
  now: number,
  timezone: string,
): { year: number; month: number; day: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type: string): number =>
    Number(parts.find(candidate => candidate.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
};

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The budget period `now` falls in, e.g. `week:2026-W44` or `month:2026-10`.
 * Weeks are ISO 8601: they start on Monday, and week 1 holds the year's first
 * Thursday, so 1 January can belong to the previous year's last week.
 */
export const rewardPeriodKey = (
  now: number,
  period: BudgetPeriod,
  timezone: string,
): string => {
  const { year, month, day } = localDate(now, timezone);
  if (period === 'month') {
    return `month:${year}-${pad(month)}`;
  }
  // Pure date arithmetic on the local calendar date, at UTC midnight.
  const date = Date.UTC(year, month - 1, day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = date + (3 - weekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const week =
    Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1;
  return `week:${isoYear}-W${pad(week)}`;
};

/**
 * Roughly when a period started (UTC midnight of its first day), for pruning
 * old periods. Not used for any money decision.
 */
export const periodStartMs = (periodKey: string): number => {
  const month = /^month:(\d{4})-(\d{2})$/.exec(periodKey);
  if (month) {
    return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1);
  }
  const week = /^week:(\d{4})-W(\d{2})$/.exec(periodKey);
  if (week) {
    const isoYear = Number(week[1]);
    // The Monday of ISO week 1 is the Monday on or before 4 January.
    const january4 = Date.UTC(isoYear, 0, 4);
    const weekday = (new Date(january4).getUTCDay() + 6) % 7;
    return january4 - weekday * DAY_MS + (Number(week[2]) - 1) * 7 * DAY_MS;
  }
  return Number.NaN;
};
