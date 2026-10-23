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

test('every filesystem-limitation errno is warned about, not fatal', posixOnly, () => {
  // Which errno a mount picks for an unsupported chmod is not contractual;
  // CIFS, NFS, overlayfs and FUSE drivers differ.
  for (const code of ['EPERM', 'EACCES', 'EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']) {
    const dir = path.join(tempDir, `limited-${code}`);
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    resetChmodWarningsForTests();

    const realChmodSync = fs.chmodSync;
    const realWarn = console.warn;
    console.warn = () => {};
    fs.chmodSync = (target, mode) => {
      if (path.resolve(target) === path.resolve(dir)) {
        const error = new Error(`${code}: chmod '${target}'`);
        error.code = code;
        throw error;
      }
      return realChmodSync(target, mode);
    };

    try {
      writeJsonSecure(path.join(dir, 'store.json'), { code });
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')),
        { code },
      );
    } finally {
      fs.chmodSync = realChmodSync;
      console.warn = realWarn;
      resetChmodWarningsForTests();
    }
  }
});

test('a chmod error that is not a mode limitation is not swallowed', posixOnly, () => {
  // EPERM means the mount will not express the mode. EIO means the directory
  // itself is broken — writing secrets into it anyway is not best effort, it is
  // ignoring a fault.
  const dir = path.join(tempDir, 'broken');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  resetChmodWarningsForTests();

  const realChmodSync = fs.chmodSync;
  const realWarn = console.warn;
  const warnings = [];
  fs.chmodSync = (target, mode) => {
    if (path.resolve(target) === path.resolve(dir)) {
      const error = new Error(`EIO: i/o error, chmod '${target}'`);
      error.code = 'EIO';
      throw error;
    }
    return realChmodSync(target, mode);
  };
  console.warn = (message) => warnings.push(message);

  try {
    assert.throws(() => writeJsonSecure(path.join(dir, 'store.json'), { ok: true }), {
      code: 'EIO',
    });
    assert.equal(fs.existsSync(path.join(dir, 'store.json')), false);
    assert.equal(warnings.length, 0);
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
