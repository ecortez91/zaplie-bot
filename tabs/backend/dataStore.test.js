const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDataStrict } = require('./dataStore');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-data-store-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a missing data.json is an empty store', () => {
  assert.deepEqual(readDataStrict(path.join(dir, 'missing.json'))(), {});
});

test('a good data.json returns its object', () => {
  const file = path.join(dir, 'good.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ rewardName: 'sats', allowancePolicy: { enabled: true } }),
  );
  assert.deepEqual(readDataStrict(file)(), {
    rewardName: 'sats',
    allowancePolicy: { enabled: true },
  });
});

test('a corrupt data.json throws instead of reading as no settings', () => {
  const file = path.join(dir, 'corrupt.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(readDataStrict(file), SyntaxError);
});

test('a read error other than a missing file throws (a directory in its place)', () => {
  const file = path.join(dir, 'is-a-directory');
  fs.mkdirSync(file);
  assert.throws(readDataStrict(file), error => error.code === 'EISDIR');
});
