const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  writeJsonSecure,
  resetChmodWarningsForTests,
} = require('./secureJsonStore');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-secure-store-'));

after(() => {
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.equal(path.resolve(tempDir).startsWith(safePrefix), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Windows never reaches the chmod branch.
const posixOnly = { skip: process.platform === 'win32' };

test('a store write survives a filesystem that refuses chmod', posixOnly, () => {
  // Azure Files (CIFS) answers chmod with EPERM. The store must still land.
  const dir = path.join(tempDir, 'cifs-like');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  resetChmodWarningsForTests();

  const realChmodSync = fs.chmodSync;
  const realWarn = console.warn;
  const warnings = [];
  let chmodAttempts = 0;
  fs.chmodSync = (target, mode) => {
    if (path.resolve(target) === path.resolve(dir)) {
      chmodAttempts += 1;
      const error = new Error(`EPERM: operation not permitted, chmod '${target}'`);
      error.code = 'EPERM';
      throw error;
    }
    return realChmodSync(target, mode);
  };
  console.warn = (message) => warnings.push(message);

  try {
    const filePath = path.join(dir, 'store.json');
    writeJsonSecure(filePath, { first: true });
    writeJsonSecure(filePath, { second: true });
    writeJsonSecure(path.join(dir, 'other.json'), { third: true });

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { second: true });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, 'other.json'), 'utf8')),
      { third: true },
    );
    // Warned once, and never retried the syscall the mount cannot serve.
    assert.equal(warnings.length, 1);
    assert.equal(chmodAttempts, 1);
    assert.match(warnings[0], /EPERM/);
    assert.ok(warnings[0].includes(dir));
  } finally {
    fs.chmodSync = realChmodSync;
    console.warn = realWarn;
    resetChmodWarningsForTests();
  }
});

test('a chmod-capable directory is still narrowed to owner-only', posixOnly, () => {
  const dir = path.join(tempDir, 'posix-like');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);

  writeJsonSecure(path.join(dir, 'store.json'), { ok: true });

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
