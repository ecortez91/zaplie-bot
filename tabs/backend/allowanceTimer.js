// The periodic allowance sync, so a new person gets their schedule without
// anyone running it by hand.
//
// It is deliberately narrower than an admin's apply:
// - ALLOWANCE_SYNC_DISABLED=true or ALLOWANCE_SYNC_INTERVAL_MINUTES=0 turns
//   it off;
// - an enabled policy is only maintained once a person (an admin or the CLI)
//   has applied that exact policy with a confirmed total; a changed policy
//   waits for them;
// - a disabled policy is applied (it only pauses schedules and creates
//   nothing), so the kill switch takes effect without anyone present;
// - anything that blocks an apply (underfunded, mass-delete and
//   people-incomplete included) stops it; the timer never overrides a block
//   and never overwrites a hand edit the policy does not already allow
//   overwriting.
// The sync's lock (allowance-sync.lock in the data directory) keeps it from
// overlapping an admin's run in this process or the CLI in another one; a
// busy lock is left for the next tick. The first tick is one full interval
// after start, not at start.
const { isPolicyActive, readAllowancePolicy } = require('./allowancePolicy');
const { readFundKeys } = require('./allowanceExtensionClient');
const { TIMER_ACTOR, runAllowanceSync } = require('./allowanceSync');

const DEFAULT_INTERVAL_MINUTES = 360;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** The interval and the off switch, read the way the other settings are. */
const timerSettings = (env = process.env) => {
  const disabled = String(env.ALLOWANCE_SYNC_DISABLED || '').trim().toLowerCase() === 'true';
  const raw = String(env.ALLOWANCE_SYNC_INTERVAL_MINUTES ?? '').trim();
  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  let invalid = false;
  if (raw !== '') {
    const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isSafeInteger(value) || value > MAX_INTERVAL_MINUTES) {
      // Malformed means off, never a guessed interval.
      invalid = true;
      intervalMinutes = 0;
    } else {
      intervalMinutes = value;
    }
  }
  return { disabled, intervalMinutes, invalid, enabled: !disabled && intervalMinutes > 0 };
};

const createAllowanceTimer = ({
  readData,
  store,
  env = process.env,
  runSync = runAllowanceSync,
  log = console,
}) => {
  const tick = async () => {
    if (!timerSettings(env).enabled) {
      return { skipped: 'timer-off' };
    }
    if (readFundKeys(env).length === 0) {
      return { skipped: 'fund-not-configured' };
    }
    let policy;
    try {
      policy = readAllowancePolicy(readData());
    } catch (_error) {
      return { skipped: 'policy-invalid' };
    }
    if (isPolicyActive(policy)) {
      const confirmed = store.read().lastAdminApply;
      if (!confirmed || confirmed.policyUpdatedAt !== policy.updatedAt) {
        return { skipped: 'awaiting-admin-apply' };
      }
    }
    try {
      const preview = await runSync({ mode: 'dry', by: TIMER_ACTOR }, { readData, store, env });
      if (preview.blockers.length > 0) {
        log.warn(
          `Allowance timer: not applying (${preview.blockers.map((blocker) => blocker.code).join(', ')})`,
        );
        return { skipped: 'blocked', blockers: preview.blockers.map((blocker) => blocker.code) };
      }
      if (preview.summary.changes === 0) {
        return { skipped: 'nothing-to-do' };
      }
      const applied = await runSync(
        {
          mode: 'apply',
          confirmTotalSats: preview.summary.totalPerPeriodSats,
          by: TIMER_ACTOR,
        },
        { readData, store, env },
      );
      const r = applied.result;
      log.log(
        `Allowance timer: created ${r.created}, updated ${r.updated}, deleted ${r.deleted}, ` +
          `pay links ${r.payLinks}, drift ${r.drift}, errors ${r.errors}${r.aborted ? ', stopped' : ''}`,
      );
      return { applied: r };
    } catch (error) {
      // A busy lock or a plan that moved between preview and apply: next tick.
      log.warn(`Allowance timer: ${error?.code || 'error'}: ${String(error?.message || error).slice(0, 200)}`);
      return { skipped: error?.code || 'error' };
    }
  };

  let handle = null;
  const start = () => {
    const settings = timerSettings(env);
    if (settings.invalid) {
      log.warn('Allowance timer: ALLOWANCE_SYNC_INTERVAL_MINUTES is malformed; the timer is off');
    }
    if (!settings.enabled || handle) {
      return false;
    }
    handle = setInterval(() => {
      void tick();
    }, settings.intervalMinutes * 60 * 1000);
    handle.unref?.();
    return true;
  };
  const stop = () => {
    if (handle) clearInterval(handle);
    handle = null;
  };

  return { tick, start, stop };
};

module.exports = { DEFAULT_INTERVAL_MINUTES, createAllowanceTimer, timerSettings };
