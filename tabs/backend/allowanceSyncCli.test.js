const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { main, parseArgs } = require('./scripts/allowance-sync');
const { createAllowanceSyncStore } = require('./allowanceSyncStore');

const OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SECRET = 'e'.repeat(32);
// Test values only.
const POLICY = {
  enabled: true,
  amountSats: 25000,
  period: 'weekly',
  anchorWeekday: 5,
  anchorTime: '09:00',
  timezone: 'Europe/London',
};

const capture = () => {
  let text = '';
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
};

const fakeGather = (calls) => async () => ({
  snapshot: {
    people: [{ oid: OID, displayName: 'Ada', walletId: 'w1', walletIssue: null }],
    payLinks: { w1: null },
    allowances: [],
    fund: { configured: true, wallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 1_000_000 }] },
    health: { healthy: true, overdue: 0, pending: 0 },
  },
  clients: new Map([['fund-1', { secret: SECRET }]]),
  fundOrder: ['fund-1'],
  wallets: new Map([['w1', { id: 'w1', adminkey: SECRET }]]),
  calls,
});

const tempStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-cli-'));
  return createAllowanceSyncStore({
    statePath: path.join(dir, 'state.json'),
    auditPath: path.join(dir, 'audit.jsonl'),
  });
};

const deps = (applied) => ({
  readData: () => ({ allowancePolicy: POLICY }),
  store: tempStore(),
  env: { ALLOWANCE_FUND_ADMINKEY: SECRET, LNBITS_PUBLIC_HOST: 'bank.example.test' },
  gather: fakeGather([]),
  apply: async (plan) => {
    applied.push(plan);
    return {
      results: plan.actions
        .filter((action) => ['paylink-create', 'create'].includes(action.kind))
        .map((action) => ({ action, ok: true, row: action.kind === 'create' ? { id: 'r1', ...action.body } : undefined, linkId: 'l1' })),
      aborted: null,
    };
  },
});

test('the CLI previews by default and prints the apply command, no key', async () => {
  const stdout = capture();
  const applied = [];
  const code = await main([], { stdout, stderr: capture(), deps: deps(applied) });
  assert.equal(code, 0);
  assert.equal(applied.length, 0, 'a preview applies nothing');
  assert.match(stdout.text, /Total per period: 25000 sats/);
  assert.match(stdout.text, /--apply --confirm-total 25000/);
  assert.match(stdout.text, /Nothing was changed/);
  assert.equal(stdout.text.includes(SECRET), false);
});

test('the CLI applies only with the matching --confirm-total', async () => {
  const applied = [];
  const stderr = capture();
  assert.equal(
    await main(['--apply', '--confirm-total', '1'], { stdout: capture(), stderr, deps: deps(applied) }),
    1,
  );
  assert.match(stderr.text, /confirmTotalSats does not match/);
  assert.equal(applied.length, 0);

  const stdout = capture();
  assert.equal(
    await main(['--apply', '--confirm-total', '25000'], { stdout, stderr: capture(), deps: deps(applied) }),
    0,
  );
  assert.equal(applied.length, 1);
  assert.match(stdout.text, /Applied: created 1/);
  assert.equal(stdout.text.includes(SECRET), false);
});

test('the CLI JSON output carries no key', async () => {
  const stdout = capture();
  await main(['--json'], { stdout, stderr: capture(), deps: deps([]) });
  const parsed = JSON.parse(stdout.text);
  assert.equal(parsed.summary.creates, 1);
  assert.equal(stdout.text.includes(SECRET), false);
  assert.equal(/adminkey|inkey/i.test(stdout.text), false);
});

test('the CLI stores a validated policy without calling LNbits, and refuses an invalid one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-cli-policy-'));
  const dataFile = path.join(dir, 'data.json');
  fs.writeFileSync(dataFile, JSON.stringify({ rewardName: 'sats' }));
  const policyFile = path.join(dir, 'policy.json');
  const noLnbits = {
    dataFile,
    gather: async () => assert.fail('no LNbits call expected'),
  };

  fs.writeFileSync(policyFile, JSON.stringify({ ...POLICY, memo: 'Weekly Allowance cleared' }));
  const stderr = capture();
  assert.equal(await main(['--set-policy', policyFile], { stdout: capture(), stderr, deps: noLnbits }), 1);
  assert.match(stderr.text, /hidden/);
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).allowancePolicy, undefined);

  fs.writeFileSync(policyFile, JSON.stringify(POLICY));
  const stdout = capture();
  assert.equal(await main(['--set-policy', policyFile], { stdout, stderr: capture(), deps: noLnbits }), 0);
  const stored = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(stored.rewardName, 'sats', 'other settings are kept');
  assert.equal(stored.allowancePolicy.enabled, true);
  assert.equal(stored.allowancePolicy.updatedBy, 'cli');
  assert.match(stdout.text, /Nothing in LNbits changed/);
});

test('the CLI refuses --apply without --confirm-total and unknown options', () => {
  assert.throws(() => parseArgs(['--apply']), /--confirm-total/);
  assert.throws(() => parseArgs(['--confirm-total', 'abc']), /whole number/);
  assert.throws(() => parseArgs(['--yes']), /unknown option/);
  assert.deepEqual(parseArgs(['--apply', '--confirm-total', '0', '--allow-underfunded']), {
    mode: 'apply',
    json: false,
    overwriteDrift: false,
    allowUnderfunded: true,
    confirmTotalSats: 0,
  });
});
