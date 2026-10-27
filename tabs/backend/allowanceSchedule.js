// Wall-clock arithmetic for allowance anchors ("Friday 09:00 in
// Europe/London"). The extension stores start_datetime in UTC with the time
// zone beside it, and recurs from there, so Zaplie sends the next anchor as a
// UTC instant and later checks a stored schedule against the anchor rather
// than against an exact date (which moves forward every period).
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// The extension refuses a start less than one minute ahead; keep a margin for
// the time between planning and the request.
const MIN_LEAD_MS = 5 * MINUTE_MS;

const wallClock = (ms, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: weekdays[get('weekday')],
  };
};

// The zone's offset from UTC at an instant, in milliseconds.
const offsetAt = (ms, timezone) => {
  const local = wallClock(ms, timezone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
};

/** The UTC instant of a wall-clock time in a zone (the later one in a DST overlap). */
const zonedToUtc = ({ year, month, day, hour, minute }, timezone) => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - offsetAt(guess, timezone);
  // A second pass settles the offset when the first guess crossed a DST edge.
  utc = guess - offsetAt(utc, timezone);
  return utc;
};

const parseTime = (anchorTime) => {
  const [hour, minute] = anchorTime.split(':').map(Number);
  return { hour, minute };
};

/**
 * The next anchor strictly after `now` plus the lead time, as a Date.
 * Weekly: the next anchorWeekday at anchorTime. Monthly: the next anchorDay.
 */
const nextAnchor = (policy, now = new Date()) => {
  const { hour, minute } = parseTime(policy.anchorTime);
  const earliest = now.getTime() + MIN_LEAD_MS;
  const today = wallClock(now.getTime(), policy.timezone);
  if (policy.period === 'weekly') {
    for (let offset = 0; offset <= 8; offset += 1) {
      const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + offset * DAY_MS);
      if (date.getUTCDay() !== policy.anchorWeekday) continue;
      const candidate = zonedToUtc(
        {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          day: date.getUTCDate(),
          hour,
          minute,
        },
        policy.timezone,
      );
      if (candidate >= earliest) return new Date(candidate);
    }
  } else if (policy.period === 'monthly') {
    for (let offset = 0; offset <= 2; offset += 1) {
      const monthIndex = today.month - 1 + offset;
      const candidate = zonedToUtc(
        {
          year: today.year + Math.floor(monthIndex / 12),
          month: (monthIndex % 12) + 1,
          day: policy.anchorDay,
          hour,
          minute,
        },
        policy.timezone,
      );
      if (candidate >= earliest) return new Date(candidate);
    }
  }
  throw new Error('allowance policy has no computable anchor');
};

/**
 * Whether a stored schedule's start falls on the policy's anchor: the same
 * weekday (or day of month) and time in the policy's zone. The start date
 * itself is not compared, since it is fixed at creation.
 */
const startMatchesAnchor = (startIso, policy) => {
  const ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) return false;
  const local = wallClock(ms, policy.timezone);
  const { hour, minute } = parseTime(policy.anchorTime);
  if (local.hour !== hour || local.minute !== minute) return false;
  if (policy.period === 'weekly') return local.weekday === policy.anchorWeekday;
  if (policy.period === 'monthly') return local.day === policy.anchorDay;
  return false;
};

module.exports = { MIN_LEAD_MS, nextAnchor, startMatchesAnchor, zonedToUtc };
