// The mode argument of fs.writeFileSync only applies when the call creates the
// file, and these stores rewrite files that already exist. Writing to a fresh
// temporary file and renaming it over the target applies the mode for real and
// makes the replacement atomic, so a crash mid-write cannot truncate the store.
const fs = require('fs');
const path = require('path');

// Directories whose chmod has already been refused by the filesystem. Azure
// Files (CIFS) — where ZAPLIE_DATA_DIR points in production on Linux App
// Service — answers chmod with EPERM, so retrying it on every write would burn
// a failing syscall per store write and repeat the same warning for ever.
const chmodRefused = new Set();

// Errnos that mean "this filesystem will not express that mode": the mount
// cannot honour it, or will not let us. Which one a mount picks is not
// contractual — CIFS, NFS, overlayfs and FUSE drivers differ — so the whole
// family is treated as a permissions limitation to warn about and carry on
// past. Anything else (ENOENT, EIO, ENOTDIR, ELOOP…) says the directory itself
// is wrong, which is a real fault and must not be written into.
const UNSUPPORTED_MODE_CODES = new Set([
  'EPERM',
  'EACCES',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

const ensureSecureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync applies the mode only when it creates the directory, so an
  // existing store would keep whatever permissions it was given. Windows has no
  // POSIX mode to correct, so the check there would fire on every write.
  if (process.platform === 'win32' || chmodRefused.has(dir)) {
    return;
  }
  if ((fs.statSync(dir).mode & 0o777) === 0o700) {
    return;
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    if (!UNSUPPORTED_MODE_CODES.has(error.code)) {
      throw error;
    }
    // Tightening permissions is best effort: a mount that cannot express them
    // must not take every store write down with it.
    chmodRefused.add(dir);
    console.warn(
      `Could not restrict permissions on ${dir} (${error.code || error.message}). ` +
        'Continuing with the permissions the filesystem provides — secure the ' +
        'mount itself if it cannot honour chmod (Azure Files does not).',
    );
  }
};

const writeJsonSecure = (filePath, data) => {
  ensureSecureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
};

// Tests need a fresh "have we already warned about this directory" slate.
const resetChmodWarningsForTests = () => {
  chmodRefused.clear();
};

module.exports = { ensureSecureDir, writeJsonSecure, resetChmodWarningsForTests };
