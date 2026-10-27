import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { acquireLock, LedgerFile, recoverStaleLock } from './ledgerFile';
import * as pulse from './pulse';

class TestLedgerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TestLedgerError';
  }
}

const tempDirectories: string[] = [];
const ownerToken = 'cd'.repeat(32);

const newFile = (): LedgerFile => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-lockfile-'));
  tempDirectories.push(directory);
  const storePath = path.join(directory, 'store.json');
  return {
    storePath,
    lockPath: `${storePath}.lock`,
    label: 'Test ledger',
    lockTimeoutImpact: 'every test write fails',
    lockRetryMs: 5,
    errorType: TestLedgerError,
    activityChannel: 'teams',
  };
};

const writeLock = (lockPath: string, mtimeMs: number): void => {
  fs.writeFileSync(lockPath, ownerToken, { mode: 0o600 });
  fs.utimesSync(lockPath, new Date(mtimeMs), new Date(mtimeMs));
};

afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('recoverStaleLock', () => {
  test('no lock means nothing to do', () => {
    const file = newFile();
    expect(recoverStaleLock(file, Date.now(), 30_000)).toBe('none');
  });

  test('a threshold of 0 never touches the lock', () => {
    const file = newFile();
    writeLock(file.lockPath, 0);
    expect(recoverStaleLock(file, Date.now(), 0)).toBe('none');
    expect(fs.readFileSync(file.lockPath, 'utf8')).toBe(ownerToken);
  });

  test('a lock younger than the threshold is kept and reported', () => {
    const file = newFile();
    const now = Date.now();
    writeLock(file.lockPath, now - 5_000);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(recoverStaleLock(file, now, 30_000)).toBe('kept');

    expect(fs.readFileSync(file.lockPath, 'utf8')).toBe(ownerToken);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain(
      'may belong to a live process',
    );
    expect(String(errors.mock.calls[0][0])).toContain('docs/DEPLOYMENT.adoc');
  });

  test('a lock older than the threshold is removed and reported', () => {
    const file = newFile();
    const now = Date.now();
    writeLock(file.lockPath, now - 60_000);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(recoverStaleLock(file, now, 30_000)).toBe('removed');

    expect(fs.existsSync(file.lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(file.lockPath))
        .filter(name => name.includes('.stale.')),
    ).toEqual([]);
    const line = String(errors.mock.calls[0][0]);
    expect(line).toContain('removed as crash-left');
    expect(line).toContain('owner token cdcdcdcd');
    expect(line).not.toContain(ownerToken);
    expect(line).toContain(file.storePath);
  });

  test('a lock replaced between stat and rename is put back', () => {
    const file = newFile();
    const now = Date.now();
    writeLock(file.lockPath, now - 60_000);
    const liveToken = 'ef'.repeat(32);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // A live process releases the stale-looking lock and takes a fresh one in
    // the gap between our checks and the rename.
    const result = recoverStaleLock(file, now, 30_000, {
      beforeRename: () => {
        fs.unlinkSync(file.lockPath);
        fs.writeFileSync(file.lockPath, liveToken, { mode: 0o600 });
      },
    });

    expect(result).toBe('kept');
    expect(fs.readFileSync(file.lockPath, 'utf8')).toBe(liveToken);
    expect(
      fs
        .readdirSync(path.dirname(file.lockPath))
        .filter(name => name.includes('.stale.')),
    ).toEqual([]);
  });

  test('a lock that disappears before the rename is not an error', () => {
    const file = newFile();
    const now = Date.now();
    writeLock(file.lockPath, now - 60_000);

    const result = recoverStaleLock(file, now, 30_000, {
      beforeRename: () => fs.unlinkSync(file.lockPath),
    });

    expect(result).toBe('none');
    expect(fs.existsSync(file.lockPath)).toBe(false);
  });

  test('a lock that cannot be inspected fails startup closed', () => {
    const base = newFile();
    // A path under a regular file: stat fails with ENOTDIR, not ENOENT.
    fs.writeFileSync(base.storePath, '{}', { mode: 0o600 });
    const file = { ...base, lockPath: path.join(base.storePath, 'x.lock') };

    expect(() => recoverStaleLock(file, Date.now(), 30_000)).toThrow(
      'Test ledger lock could not be inspected at startup',
    );
    expect(() => recoverStaleLock(file, Date.now(), 30_000)).toThrow(
      TestLedgerError,
    );
  });
});

describe('acquireLock timeout', () => {
  test('records a ledger-lock activity so an alert can fire on it', async () => {
    const file = newFile();
    writeLock(file.lockPath, Date.now());
    const record = jest
      .spyOn(pulse, 'recordActivity')
      .mockImplementation(() => {});

    await expect(acquireLock(file, 15)).rejects.toThrow(
      'Test ledger lock timed out',
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      level: 'error',
      subject: 'ledger-lock',
      title: 'Ledger lock timed out',
    });
  });
});
