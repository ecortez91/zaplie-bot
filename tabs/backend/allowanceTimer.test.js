const assert = require('node:assert/strict');
const test = require('node:test');
const { createAllowanceTimer, timerSettings } = require('./allowanceTimer');
const { AllowanceSyncError } = require('./allowanceSync');

// Test values only.
const POLICY = {
  enabled: true,
  amountSats: 25000,
  period: 'weekly',
  anchorWeekday: 5,
  anchorTime: '09:00',
  timezone: 'Europe/London',
  updatedAt: '2026-10-28T10:00:00.000Z',
  updatedBy: 'admin',
};
const ENV = { ALLOWANCE_FUND_ADMINKEY: 'fund-key' };
const quiet = { log: () => {}, warn: () => {} };

const memoryStore = (state = {}) => ({
  read: () => ({ byPerson: {}, runs: [], ...state }),
  write: () => {},
  appendAudit: () => {},
});

const preview = (summary = {}, blockers = []) => ({
  mode: 'dry',
  summary: { changes: 1, totalPerPeriodSats: 50000, ...summary },
  blockers,
});

const timer = ({ policy = POLICY, state = {}, env = ENV, runs, readData } = {}) => {
  const calls = [];
  const queue = [...(runs || [])];
  const instance = createAllowanceTimer({
    readData: readData || (() => ({ allowancePolicy: policy })),
    store: memoryStore(state),
    env,
    log: quiet,
    runSync: async (options) => {
      calls.push(options);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { instance, calls };
};

test('timer settings: default 360 minutes; 0, the off switch or a malformed value turn it off', () => {
  assert.deepEqual(timerSettings({}), {
    disabled: false,
    intervalMinutes: 360,
    invalid: false,
    enabled: true,
  });
  assert.equal(timerSettings({ ALLOWANCE_SYNC_INTERVAL_MINUTES: '0' }).enabled, false);
  assert.equal(timerSettings({ ALLOWANCE_SYNC_DISABLED: 'true' }).enabled, false);
  const bad = timerSettings({ ALLOWANCE_SYNC_INTERVAL_MINUTES: '1e3' });
  assert.equal(bad.enabled, false);
  assert.equal(bad.invalid, true);
  assert.equal(timerSettings({ ALLOWANCE_SYNC_INTERVAL_MINUTES: '60' }).intervalMinutes, 60);
});

test('the timer does nothing when off, without a Fund key, or with an invalid policy', async () => {
  for (const [env, policy, reason] of [
    [{ ...ENV, ALLOWANCE_SYNC_DISABLED: 'true' }, POLICY, 'timer-off'],
    [{}, POLICY, 'fund-not-configured'],
    [ENV, { enabled: true }, 'policy-invalid'],
  ]) {
    const { instance, calls } = timer({ env, policy });
    assert.deepEqual(await instance.tick(), { skipped: reason });
    assert.equal(calls.length, 0);
  }
});

test('an unreadable data.json is policy-invalid: the timer never runs a sync', async () => {
  const { instance, calls } = timer({
    readData: () => {
      throw new SyntaxError('Unexpected token n in JSON at position 1');
    },
  });
  assert.deepEqual(await instance.tick(), { skipped: 'policy-invalid' });
  assert.equal(calls.length, 0);
});

test('an enabled policy waits until a person has applied that exact policy', async () => {
  const never = timer();
  assert.deepEqual(await never.instance.tick(), { skipped: 'awaiting-admin-apply' });
  assert.equal(never.calls.length, 0);

  const older = timer({ state: { lastAdminApply: { policyUpdatedAt: '2026-10-01T00:00:00.000Z' } } });
  assert.deepEqual(await older.instance.tick(), { skipped: 'awaiting-admin-apply' });
});

test('after an admin apply, the timer applies with the preview total and no overrides', async () => {
  const { instance, calls } = timer({
    state: { lastAdminApply: { policyUpdatedAt: POLICY.updatedAt } },
    runs: [
      preview(),
      { result: { created: 1, updated: 0, deleted: 0, payLinks: 1, drift: 0, errors: 0, aborted: null } },
    ],
  });
  const outcome = await instance.tick();
  assert.equal(outcome.applied.created, 1);
  assert.deepEqual(calls, [
    { mode: 'dry', by: 'timer' },
    { mode: 'apply', confirmTotalSats: 50000, by: 'timer' },
  ]);
});

test('the timer never applies over a blocker, and skips when nothing changes', async () => {
  const state = { lastAdminApply: { policyUpdatedAt: POLICY.updatedAt } };
  const blocked = timer({
    state,
    runs: [preview({}, [{ code: 'underfunded', overridable: true }])],
  });
  assert.deepEqual(await blocked.instance.tick(), { skipped: 'blocked', blockers: ['underfunded'] });
  assert.equal(blocked.calls.length, 1);

  const idle = timer({ state, runs: [preview({ changes: 0 })] });
  assert.deepEqual(await idle.instance.tick(), { skipped: 'nothing-to-do' });
  assert.equal(idle.calls.length, 1);
});

test('a disabled policy (the kill switch) is applied without waiting for anyone', async () => {
  const { instance, calls } = timer({
    policy: { ...POLICY, enabled: false },
    runs: [
      preview({ totalPerPeriodSats: 0, changes: 2 }),
      { result: { created: 0, updated: 2, deleted: 0, payLinks: 0, drift: 0, errors: 0, aborted: null } },
    ],
  });
  const outcome = await instance.tick();
  assert.equal(outcome.applied.updated, 2);
  assert.equal(calls[1].confirmTotalSats, 0);
});

test('a busy lock or a moved plan is left for the next tick', async () => {
  const state = { lastAdminApply: { policyUpdatedAt: POLICY.updatedAt } };
  const busy = timer({ state, runs: [new AllowanceSyncError('busy', 409, 'busy')] });
  assert.deepEqual(await busy.instance.tick(), { skipped: 'busy' });
  const moved = timer({
    state,
    runs: [preview(), new AllowanceSyncError('mismatch', 409, 'confirm-mismatch')],
  });
  assert.deepEqual(await moved.instance.tick(), { skipped: 'confirm-mismatch' });
});

test('start honours the off switch and does not start twice', () => {
  const off = createAllowanceTimer({
    readData: () => ({}),
    store: memoryStore(),
    env: { ALLOWANCE_SYNC_INTERVAL_MINUTES: '0' },
    log: quiet,
  });
  assert.equal(off.start(), false);
  const on = createAllowanceTimer({ readData: () => ({}), store: memoryStore(), env: {}, log: quiet });
  assert.equal(on.start(), true);
  assert.equal(on.start(), false);
  on.stop();
});

test('with the real sync, a lock held by the CLI makes the tick wait, touching nothing', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createAllowanceSyncStore } = require('./allowanceSyncStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-timer-'));
  const store = createAllowanceSyncStore({
    statePath: path.join(dir, 'state.json'),
    auditPath: path.join(dir, 'audit.jsonl'),
  });
  const cli = store.acquireLock();
  assert.equal(cli.acquired, true);
  const warnings = [];
  const instance = createAllowanceTimer({
    // A disabled policy is applied without waiting for an admin.
    readData: () => ({ allowancePolicy: { ...POLICY, enabled: false } }),
    store,
    env: ENV,
    log: { log: () => {}, warn: (line) => warnings.push(line) },
  });
  try {
    assert.deepEqual(await instance.tick(), { skipped: 'busy' });
    assert.match(warnings[0], /busy/);
    assert.equal(fs.existsSync(store.statePath), false, 'nothing was written');
  } finally {
    cli.release();
  }
});
