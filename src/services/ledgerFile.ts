// File primitives shared by the bot's on-disk money ledgers (the zap-card
// ledger and the automation reward ledger): an exclusive lock file, atomic
// whole-store replacement, and crash-temporary cleanup. Each ledger owns its
// own schema and validation; this module only knows how to move bytes safely.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { nonNegativeIntFromEnv } from './envNumbers';
import { recordActivity } from './pulse';

// Windows enforces mandatory sharing, so a concurrent lock-free reader holding
// the canonical store open can make MoveFileEx(REPLACE_EXISTING) fail with
// EPERM/EACCES/EBUSY. Those handles are held for a single readFileSync, so a
// few short retries clear a sharing violation that would otherwise strand a
// settled payment in `processing`.
const RENAME_SHARING_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_ATTEMPTS = 5;
const RENAME_RETRY_MS = 20;
// A crash between writing a temporary and renaming it leaves that temporary
// behind: the catch block that would remove it never runs. Each one is a full
// ledger snapshot, so repeated crashes would grow without bound on the
// persistent share. An hour is far longer than any write, so anything older
// than that belongs to a dead process, never to a write in flight.
const STALE_TEMP_MS = 60 * 60 * 1000;
const LOCK_WAIT_LOG_MS = 5_000;
// The lock is only ever held across local file I/O (a read, a JSON serialise
// and one fsync'd rename), so a healthy hold lasts milliseconds. At startup a
// lock older than this belongs to a process that died holding it. Thirty
// seconds sits below a typical crash-plus-boot gap, so the common restart
// recovers on its own, and far above any live hold.
export const STALE_LOCK_ENV = 'ZAPLIE_LEDGER_STALE_LOCK_MS';
export const DEFAULT_STALE_LOCK_MS = 30_000;

export type LedgerErrorType = new (message: string, cause?: unknown) => Error;

export interface LedgerFile {
  storePath: string;
  lockPath: string;
  // Prefix of every error message, e.g. 'Zap ledger'.
  label: string;
  // What stops working while the lock is held, named in the timeout error.
  lockTimeoutImpact: string;
  lockRetryMs: number;
  errorType: LedgerErrorType;
  // Telemetry channel of the payments this store guards: Teams zap cards or
  // the rewards API.
  activityChannel: 'teams' | 'api';
}

/** True for a Node system error that carries an errno `code` (e.g. ENOENT). */
export const isErrnoException = (
  error: unknown,
): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

/** Resolves after the given number of milliseconds. */
export const wait = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Returns `value` if it is a non-negative safe integer.
 *
 * @throws errorType `<name> is invalid` otherwise
 */
export const validateDuration = (
  errorType: LedgerErrorType,
  name: string,
  value: number,
): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new errorType(`${name} is invalid`);
  }
  return value;
};

/**
 * Creates the store's directory (mode 0700) if needed and checks it is
 * readable and writable, so a bad data directory fails at startup.
 */
export const ensureDataDirectory = (file: LedgerFile): void => {
  const directory = path.dirname(file.storePath);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new file.errorType(
      `${file.label} data directory is unavailable`,
      error,
    );
  }
};

/**
 * Deletes this store's own `.tmp` files older than an hour.
 *
 * Best effort by design: a crash temporary is a leftover, never a reason to
 * fail. Only this store's own temporaries match, and only ones old enough that
 * no live write could own them. Runs once when a ledger is constructed, not
 * per write: the condition it cleans up only arises after a crash, and a
 * readdir+stat on every transition would sit inside the exclusive lock.
 */
export const sweepStaleTemporaries = (
  storePath: string,
  nowMs: number,
): void => {
  const directory = path.dirname(storePath);
  const prefix = `${path.basename(storePath)}.`;
  try {
    const cutoff = nowMs - STALE_TEMP_MS;
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
        continue;
      }
      const candidate = path.join(directory, name);
      try {
        if (fs.statSync(candidate).mtimeMs < cutoff) {
          fs.unlinkSync(candidate);
        }
      } catch {
        // Another process removed it, or it is not ours to remove.
      }
    }
  } catch {
    // A directory listing failure is not a reason to refuse to start.
  }
};

/**
 * The stale-lock threshold for a ledger: the `staleLockMs` option when given,
 * else `ZAPLIE_LEDGER_STALE_LOCK_MS`, else 30 s. 0 disables recovery.
 *
 * @throws errorType `<name> is invalid` for a bad option, or naming the
 *   variable for a malformed environment value, so the bot refuses to start
 */
export const resolveStaleLockMs = (
  errorType: LedgerErrorType,
  name: string,
  option: number | undefined,
): number => {
  if (option !== undefined) {
    return validateDuration(errorType, name, option);
  }
  try {
    return nonNegativeIntFromEnv(STALE_LOCK_ENV, DEFAULT_STALE_LOCK_MS);
  } catch (error) {
    throw new errorType(
      `${STALE_LOCK_ENV} must be a non-negative integer`,
      error,
    );
  }
};

export type StaleLockRecovery = 'none' | 'kept' | 'removed';

// For tests only: runs between the last ownership check and the rename, which
// is the window a live process could re-take the lock in.
export interface StaleLockHooks {
  beforeRename?: () => void;
}

const OWNER_TOKEN_PREFIX = /^[a-f0-9]{8}/;

const statOrUndefined = (filePath: string): fs.Stats | undefined => {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

const sameFile = (left: fs.Stats, right: fs.Stats): boolean =>
  left.ino === right.ino && left.mtimeMs === right.mtimeMs;

/**
 * At startup, removes this store's lock file if it is older than
 * `staleAfterMs`.
 *
 * The lock is only held across local file I/O, so a lock that old belongs to a
 * process that died holding it (an App Service restart SIGKILLs the bot). The
 * runtime acquire path still never evicts anything: this runs once, when a
 * ledger is constructed. Records are never touched - a `processing` or
 * `unknown` entry left by the same crash keeps blocking its payment until an
 * operator reconciles it.
 *
 * The lock is moved aside with a rename, which is atomic per inode, and the
 * inode is checked on both sides: if a live process re-took the lock in the
 * gap, the moved file is put back with link(), which never clobbers a newer
 * lock.
 *
 * @returns `none` (no lock, or recovery disabled), `kept` (too young, or
 *   replaced by a live process), or `removed`
 * @throws errorType when the lock cannot be inspected, so the bot refuses to
 *   start rather than guess
 */
export const recoverStaleLock = (
  file: LedgerFile,
  nowMs: number,
  staleAfterMs: number,
  hooks: StaleLockHooks = {},
): StaleLockRecovery => {
  if (staleAfterMs === 0) {
    return 'none';
  }
  try {
    const observed = statOrUndefined(file.lockPath);
    if (!observed) {
      return 'none';
    }
    const ageMs = nowMs - observed.mtimeMs;
    const ageSeconds = Math.max(0, Math.round(ageMs / 1000));
    if (ageMs < staleAfterMs) {
      console.error(
        `${file.label} lock ${file.lockPath} is ${ageSeconds}s old and may ` +
          `belong to a live process; leaving it. If ${file.lockTimeoutImpact} ` +
          'after startup, follow the lock recovery procedure in ' +
          'docs/DEPLOYMENT.adoc.',
      );
      return 'kept';
    }

    let ownerToken: string;
    try {
      ownerToken = fs.readFileSync(file.lockPath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return 'none';
      }
      throw error;
    }
    const current = statOrUndefined(file.lockPath);
    if (!current) {
      return 'none';
    }
    if (!sameFile(current, observed)) {
      return 'kept';
    }

    hooks.beforeRename?.();
    const graveyard = `${file.lockPath}.stale.${process.pid}.${randomBytes(8).toString('hex')}`;
    try {
      fs.renameSync(file.lockPath, graveyard);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return 'none';
      }
      throw error;
    }

    const moved = fs.statSync(graveyard);
    if (!sameFile(moved, observed)) {
      // The path was re-created in the gap and we moved a live lock. Put it
      // back; link() refuses to clobber a lock taken in the meantime.
      try {
        fs.linkSync(graveyard, file.lockPath);
      } catch {
        // A newer holder owns the path, so the moved file is somebody's live
        // lock and not ours to delete. Its holder's release fails closed on
        // the ownership check instead.
        return 'kept';
      }
      fs.unlinkSync(graveyard);
      return 'kept';
    }
    fs.unlinkSync(graveyard);

    const tokenPrefix =
      OWNER_TOKEN_PREFIX.exec(ownerToken)?.[0] ?? 'unreadable';
    console.error(
      `${file.label} lock ${file.lockPath} was ${ageSeconds}s old at startup ` +
        `and has been removed as crash-left (owner token ${tokenPrefix}). Any ` +
        '`processing`, `unknown` or `uncertain` record in ' +
        `${file.storePath} still needs reconciling with LNbits before it will ` +
        'pay again (docs/DEPLOYMENT.adoc).',
    );
    return 'removed';
  } catch (error) {
    throw new file.errorType(
      `${file.label} lock could not be inspected at startup`,
      error,
    );
  }
};

// fsync of the file only guarantees its contents. On POSIX the rename itself
// is a directory update, and without syncing the directory a power loss can
// restore the old entry - losing a `paid` record that markPaid already
// returned, which a later retry would pay again. Failures are deliberately not
// caught: a durability operation that failed must fail the write. Windows has
// no directory handle to sync (opening one fails outright) and MoveFileEx is
// already ordered by the filesystem, so the step is skipped there.
const syncDirectory = async (directory: string): Promise<void> => {
  if (process.platform === 'win32') {
    return;
  }
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

// The rename itself stays atomic: a retry only re-attempts the same single
// replacement, so a reader still sees either the previous canonical file or
// the next one. Writers already hold the exclusive store lock, so no other
// writer can slip in between attempts.
const replaceStoreFile = async (
  tempPath: string,
  storePath: string,
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(tempPath, storePath);
      await syncDirectory(path.dirname(storePath));
      return;
    } catch (error) {
      const transient =
        isErrnoException(error) &&
        error.code !== undefined &&
        RENAME_SHARING_CODES.has(error.code);
      if (!transient || attempt >= RENAME_RETRY_ATTEMPTS) {
        throw error;
      }
      await wait(RENAME_RETRY_MS);
    }
  }
};

/**
 * Takes the store's exclusive lock file, retrying until `timeoutMs`.
 *
 * @returns a release function that deletes the lock only if it still holds
 *   this owner's token
 * @throws errorType when the lock times out; nothing is evicted here - a
 *   crash-left lock is only recovered at startup, by `recoverStaleLock`
 */
export const acquireLock = async (
  file: LedgerFile,
  timeoutMs: number,
): Promise<() => Promise<void>> => {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextLogAt = startedAt + LOCK_WAIT_LOG_MS;

  for (;;) {
    try {
      const handle = await fs.promises.open(file.lockPath, 'wx', 0o600);
      const ownerToken = randomBytes(32).toString('hex');
      try {
        await handle.writeFile(ownerToken, 'utf8');
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.unlink(file.lockPath).catch(() => undefined);
        throw new file.errorType(
          `${file.label} lock could not be written`,
          error,
        );
      }

      return async () => {
        try {
          await handle.close();
          const currentToken = await fs.promises.readFile(
            file.lockPath,
            'utf8',
          );
          if (currentToken !== ownerToken) {
            throw new file.errorType(`${file.label} lock ownership changed`);
          }
          await fs.promises.unlink(file.lockPath);
        } catch (error) {
          if (error instanceof file.errorType) {
            throw error;
          }
          throw new file.errorType(
            `${file.label} lock could not be released`,
            error,
          );
        }
      };
    } catch (error) {
      if (error instanceof file.errorType) {
        throw error;
      }
      if (!isErrnoException(error) || error.code !== 'EEXIST') {
        throw new file.errorType(
          `${file.label} lock could not be acquired`,
          error,
        );
      }
      if (Date.now() >= deadline) {
        // Deliberate: at runtime an orphaned lock is not evicted on a timer
        // (startup recovery handles the crash-and-restart case). Name the
        // recovery procedure so the operator is not left guessing at a bare
        // timeout, and record it so an alert can fire on it.
        recordActivity({
          activityType: 'ledger.lock_timeout',
          title: 'Ledger lock timed out',
          level: 'error',
          subject: 'ledger-lock',
          channel: file.activityChannel,
          upstreamId: `${file.lockPath}:${startedAt}`,
        });
        throw new file.errorType(
          `${file.label} lock timed out; ${file.lockTimeoutImpact} until an ` +
            'operator follows the lock recovery procedure in ' +
            'docs/DEPLOYMENT.adoc',
          error,
        );
      }
      // A long wait must not be silent: an operator watching the logs is
      // how a held lock gets noticed before the deadline arrives.
      if (Date.now() >= nextLogAt) {
        console.error(
          `Still waiting for the ${file.label.toLowerCase()} lock after ${Math.round(
            (Date.now() - startedAt) / 1000,
          )}s; another process may have crashed holding ${file.lockPath}.`,
        );
        nextLogAt = Date.now() + LOCK_WAIT_LOG_MS;
      }
      await wait(
        Math.min(file.lockRetryMs, Math.max(0, deadline - Date.now())),
      );
    }
  }
};

/** Runs `operation` while holding the store's exclusive lock. */
export const withStoreLock = async <T>(
  file: LedgerFile,
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const release = await acquireLock(file, timeoutMs);
  try {
    return await operation();
  } finally {
    await release();
  }
};

/**
 * Replaces the store with `contents`: a unique same-directory temporary,
 * fsync, atomic rename, then a directory sync on POSIX.
 *
 * The caller validates what it hands over: a bad transition must never replace
 * the last known-good file.
 */
export const writeAtomically = async (
  file: LedgerFile,
  contents: string,
): Promise<void> => {
  const tempPath = `${file.storePath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceStoreFile(tempPath, file.storePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw new file.errorType(
      `${file.label} data could not be persisted`,
      error,
    );
  }
};
