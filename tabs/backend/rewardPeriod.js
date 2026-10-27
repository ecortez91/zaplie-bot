// Budget periods for the portal's "spent this period" figure. A twin of
// src/services/rewardPeriod.ts in the bot (separate package): an ISO week
// (Monday to Sunday) or a calendar month in the configured time zone. The bot's
// budget ledger is what enforces the cap; this only reports against it.
const DAY_MS = 24 * 60 * 60 * 1000;

const localDate = (nowMs, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const part = (type) => Number(parts.find((candidate) => candidate.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
};

const pad = (value) => String(value).padStart(2, '0');

const rewardPeriodKey = (nowMs, period, timezone) => {
  const { year, month, day } = localDate(nowMs, timezone);
  if (period === 'month') {
    return `month:${year}-${pad(month)}`;
  }
  const date = Date.UTC(year, month - 1, day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7;
  const thursday = date + (3 - weekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / DAY_MS / 7) + 1;
  return `week:${isoYear}-W${pad(week)}`;
};

module.exports = { rewardPeriodKey };
