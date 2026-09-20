import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  resolveZapLedgerStorePath,
  ZapLedger,
  ZapLedgerError,
  zapKey,
} from './zapLedger';

const tempDirectories: string[] = [];

const newStorePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-ledger-'));
  tempDirectories.push(directory);
  return path.join(directory, 'ledger.json');
};

const key = (
  recipientId: string,
  overrides: Partial<Parameters<typeof zapKey>[0]> = {},
): string =>
  zapKey({
    tenantId: 'tenant-1',
    conversationId: 'conv-1',
    cardId: 'card-1',
    recipientId,
    action: 'submitZaps',
    ...overrides,
  });

const acquireInChild = (storePath: string, entryKey: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const modulePath = path.resolve(__dirname, 'zapLedger.ts');
    const script = [
      'const { ZapLedger } = require(process.argv[1]);',
      '(async () => {',
      '  const ledger = new ZapLedger({ storePath: process.argv[2] });',
      '  const acquired = await ledger.tryAcquire(process.argv[3]);',
      "  process.stdout.write(acquired ? 'acquired' : 'blocked');",
      '})().catch(error => {',
      '  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));',
      '  process.exitCode = 1;',
      '});',
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register', '-e', script, modulePath, storePath, entryKey],
      {
        cwd: process.cwd(),
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Ledger child exited with code ${code}`));
      }
    });
  });

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ZapLedger durability and concurrency', () => {
  test('only one independent instance acquires a recipient concurrently', async () => {
    const storePath = newStorePath();
    const ledgers = [
      new ZapLedger({ storePath }),
      new ZapLedger({ storePath }),
    ];

    const results = await Promise.all(
      ledgers.map(ledger => ledger.tryAcquire(key('alice'))),
    );

    expect(results.sort()).toEqual([false, true]);
    await expect(ledgers[0].get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
    });
  });

  test('two Node processes coordinate through the exclusive lock', async () => {
    const storePath = newStorePath();

    const results = await Promise.all([
      acquireInChild(storePath, key('alice')),
      acquireInChild(storePath, key('alice')),
    ]);

    expect(results.sort()).toEqual(['acquired', 'blocked']);
  });

  test('a paid entry and its payment hash survive restart', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath });
    await beforeRestart.tryAcquire(key('alice'));
    await beforeRestart.markPaid(key('alice'), 'hash-alice');

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('a paid entry recorded long ago is still locked', async () => {
    // #380 removed a TTL that let a paid card pay again a day later. A zap card
    // in a Teams thread is still clickable days on, so age must never unlock a
    // settled recipient - on the durable store either.
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath, now: () => 1 });
    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
      at: 1,
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('an old processing entry survives restart and never becomes retryable', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath, now: () => 1 });
    await beforeRestart.tryAcquire(key('alice'));

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
      at: 1,
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('an unknown outcome survives restart and never becomes retryable', async () => {
    const storePath = newStorePath();
    const beforeRestart = new ZapLedger({ storePath, now: () => 1 });
    await beforeRestart.tryAcquire(key('alice'));
    await beforeRestart.markUnknown(key('alice'));

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'unknown',
      at: 1,
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('only a processing entry can be released for a safe retry', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));
    await ledger.releaseIfProcessing(key('alice'));
    await expect(ledger.tryAcquire(key('alice'))).resolves.toBe(true);
    await ledger.markPaid(key('alice'), 'hash-alice');

    await ledger.releaseIfProcessing(key('alice'));

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  test('reads do not wait on the exclusive write lock', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({
      storePath,
      lockRetryMs: 5,
      lockTimeoutMs: 25,
    });
    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    await ledger.tryAcquire(key('bob'));
    // A writer (or a crashed one) holds the lock; readers must not block on it.
    fs.writeFileSync(ledger.lockPath, 'writer-in-progress', { mode: 0o600 });

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });

    const entries = await ledger.getMany([
      key('alice'),
      key('bob'),
      key('carol'),
    ]);

    expect(entries.get(key('alice'))).toMatchObject({ state: 'paid' });
    expect(entries.get(key('bob'))).toMatchObject({ state: 'processing' });
    expect(entries.has(key('carol'))).toBe(false);
    await expect(ledger.getMany(['not-a-hash'])).rejects.toThrow(
      'Zap ledger key is invalid',
    );

    fs.unlinkSync(ledger.lockPath);
  });

  test('a crash-left lock times out closed and is never evicted by age', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({
      storePath,
      lockRetryMs: 5,
      lockTimeoutMs: 25,
    });
    fs.writeFileSync(ledger.lockPath, 'crashed-owner', { mode: 0o600 });
    fs.utimesSync(ledger.lockPath, new Date(0), new Date(0));

    await expect(ledger.tryAcquire(key('alice'))).rejects.toThrow(
      'Zap ledger lock timed out',
    );
    expect(fs.existsSync(ledger.lockPath)).toBe(true);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('a partial crash temporary cannot replace the canonical paid entry', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    fs.writeFileSync(`${storePath}.999.crash.tmp`, '{"version":', {
      mode: 0o600,
    });

    const afterRestart = new ZapLedger({ storePath });

    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  const posixOnly = process.platform === 'win32' ? test.skip : test;

  posixOnly(
    'the rename is made durable by syncing the containing directory',
    async () => {
      const storePath = newStorePath();
      const ledger = new ZapLedger({ storePath });
      const directory = path.dirname(storePath);

      const open = fs.promises.open;
      const synced: string[] = [];
      const spy = jest
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (target, ...rest) => {
          const handle = await (
            open as unknown as (
              ...args: unknown[]
            ) => Promise<fs.promises.FileHandle>
          )(target, ...rest);
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            synced.push(String(target));
            return sync();
          };
          return handle;
        });

      try {
        await ledger.tryAcquire(key('alice'));
      } finally {
        spy.mockRestore();
      }

      // The temporary is synced for its contents; the directory is synced so
      // the rename that publishes it survives a power loss too.
      expect(synced).toContain(directory);
    },
  );

  posixOnly(
    'a directory sync failure fails the write closed, never silently',
    async () => {
      const storePath = newStorePath();
      const ledger = new ZapLedger({ storePath });
      const directory = path.dirname(storePath);

      const open = fs.promises.open;
      const spy = jest
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (target, ...rest) => {
          if (String(target) === directory) {
            throw Object.assign(new Error('EIO: i/o error, open'), {
              code: 'EIO',
            });
          }
          return (
            open as unknown as (
              ...args: unknown[]
            ) => Promise<fs.promises.FileHandle>
          )(target, ...rest);
        });

      try {
        await expect(ledger.tryAcquire(key('alice'))).rejects.toThrow(
          'Zap ledger data could not be persisted',
        );
      } finally {
        spy.mockRestore();
      }

      // Durability was not confirmed, so the slot stays taken rather than
      // handing a retry permission to pay.
      await expect(ledger.tryAcquire(key('alice'))).resolves.toBe(false);
    },
  );

  test('a Windows sharing violation on rename is retried, not left processing', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));

    const rename = fs.promises.rename;
    const sharingViolation = Object.assign(
      new Error('EPERM: operation not permitted, rename'),
      { code: 'EPERM' },
    );
    let attempts = 0;
    const spy = jest
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from, to) => {
        attempts += 1;
        // Windows denies the replacement while a reader still holds the
        // canonical store open; the handle is gone by the next attempt.
        if (attempts === 1) {
          throw sharingViolation;
        }
        return rename(from, to);
      });

    try {
      await ledger.markPaid(key('alice'), 'hash-alice');
    } finally {
      spy.mockRestore();
    }

    expect(attempts).toBeGreaterThan(1);
    const afterRestart = new ZapLedger({ storePath });
    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  test('a persistent rename failure fails closed instead of losing the outcome', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));

    const spy = jest.spyOn(fs.promises, 'rename').mockRejectedValue(
      Object.assign(new Error('EPERM: operation not permitted, rename'), {
        code: 'EPERM',
      }),
    );

    try {
      await expect(ledger.markPaid(key('alice'), 'hash-alice')).rejects.toThrow(
        'Zap ledger data could not be persisted',
      );
    } finally {
      spy.mockRestore();
    }

    const afterRestart = new ZapLedger({ storePath });
    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });

  test('a crash temporary is swept at startup, not on every write', async () => {
    const storePath = newStorePath();
    const stale = `${storePath}.999.deadbeef.tmp`;
    const fresh = `${storePath}.998.feedface.tmp`;
    const unrelated = path.join(path.dirname(storePath), 'keep-me.tmp');
    for (const file of [stale, fresh, unrelated]) {
      fs.writeFileSync(file, '{"version":', { mode: 0o600 });
    }
    // Two hours old: no write takes that long, so its owner is gone.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, longAgo, longAgo);
    fs.utimesSync(unrelated, longAgo, longAgo);

    const ledger = new ZapLedger({ storePath });

    expect(fs.existsSync(stale)).toBe(false);
    // A temporary young enough to belong to a live write is left alone, and a
    // file that is not this store's temporary is never touched.
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);

    // The sweep is a startup step: a later crash temporary survives the writes
    // that follow, instead of costing a readdir inside the exclusive lock.
    const afterStartup = `${storePath}.997.c0ffee.tmp`;
    fs.writeFileSync(afterStartup, '{"version":', { mode: 0o600 });
    fs.utimesSync(afterStartup, longAgo, longAgo);
    await ledger.tryAcquire(key('alice'));

    expect(fs.existsSync(afterStartup)).toBe(true);
    expect(fs.existsSync(`${storePath}.997.c0ffee.tmp`)).toBe(true);
    // The next process to start clears it.
    new ZapLedger({ storePath });
    expect(fs.existsSync(afterStartup)).toBe(false);
  });

  test('paid records past the retention window are pruned, unfinished ones are not', async () => {
    const storePath = newStorePath();
    const day = 24 * 60 * 60 * 1000;
    let clock = 1_000 * day;
    const ledger = new ZapLedger({ storePath, now: () => clock });

    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    await ledger.tryAcquire(key('bob'));
    await ledger.markUnknown(key('bob'));
    await ledger.tryAcquire(key('carol'));

    // Ninety-one days later: no card from then is still being clicked, but the
    // two unfinished records are still someone's job to settle.
    clock += 91 * day;
    await ledger.tryAcquire(key('dave'));

    await expect(ledger.get(key('alice'))).resolves.toBeUndefined();
    await expect(ledger.get(key('bob'))).resolves.toMatchObject({
      state: 'unknown',
    });
    await expect(ledger.get(key('carol'))).resolves.toMatchObject({
      state: 'processing',
    });
    await expect(ledger.get(key('dave'))).resolves.toMatchObject({
      state: 'processing',
    });
  });

  test('a paid record inside the retention window still blocks a resubmit', async () => {
    const storePath = newStorePath();
    const day = 24 * 60 * 60 * 1000;
    let clock = 1_000 * day;
    const ledger = new ZapLedger({ storePath, now: () => clock });

    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');

    clock += 89 * day;

    await expect(ledger.tryAcquire(key('alice'))).resolves.toBe(false);
    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });
  });

  test('retention can be switched off entirely', async () => {
    const storePath = newStorePath();
    const day = 24 * 60 * 60 * 1000;
    let clock = 1_000 * day;
    const ledger = new ZapLedger({
      storePath,
      retentionMs: 0,
      now: () => clock,
    });

    await ledger.tryAcquire(key('alice'));
    await ledger.markPaid(key('alice'), 'hash-alice');
    clock += 3_650 * day;
    await ledger.tryAcquire(key('bob'));

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
    });
  });

  test('markPaid outwaits a lock that a submit would have given up on', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({
      storePath,
      lockRetryMs: 5,
      lockTimeoutMs: 25,
      settleLockTimeoutMs: 5_000,
    });
    await ledger.tryAcquire(key('alice'));

    // Somebody else holds the lock for longer than a submit is willing to wait.
    fs.writeFileSync(ledger.lockPath, 'other-owner', { mode: 0o600 });
    const held = setTimeout(() => fs.unlinkSync(ledger.lockPath), 200);

    // A settled payment must be recorded, so markPaid keeps waiting...
    await expect(
      ledger.markPaid(key('alice'), 'hash-alice'),
    ).resolves.toBeUndefined();
    clearTimeout(held);

    await expect(ledger.get(key('alice'))).resolves.toMatchObject({
      state: 'paid',
      paymentHash: 'hash-alice',
    });

    // ...while an ordinary submit still fails fast on the short timeout.
    fs.writeFileSync(ledger.lockPath, 'other-owner', { mode: 0o600 });
    await expect(ledger.tryAcquire(key('bob'))).rejects.toThrow(
      'Zap ledger lock timed out',
    );
    fs.unlinkSync(ledger.lockPath);
  });

  test('a store written by a newer build names itself instead of failing generically', () => {
    const storePath = newStorePath();
    fs.writeFileSync(storePath, JSON.stringify({ version: 2, records: {} }), {
      mode: 0o600,
    });

    expect(() => new ZapLedger({ storePath })).toThrow(storePath);
    expect(() => new ZapLedger({ storePath })).toThrow(
      'written by a newer version of the bot',
    );
  });

  test('invalid payment hashes leave the durable processing barrier intact', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    await ledger.tryAcquire(key('alice'));

    await expect(ledger.markPaid(key('alice'), '')).rejects.toThrow(
      'Zap ledger payment hash is invalid',
    );

    const afterRestart = new ZapLedger({ storePath });
    await expect(afterRestart.get(key('alice'))).resolves.toMatchObject({
      state: 'processing',
    });
    await expect(afterRestart.tryAcquire(key('alice'))).resolves.toBe(false);
  });
});

describe('ZapLedger validation and privacy', () => {
  test('the key binds tenant, conversation, card, recipient, and action', () => {
    const base = key('alice');
    expect(key('alice', { tenantId: 'tenant-2' })).not.toBe(base);
    expect(key('alice', { conversationId: 'conv-2' })).not.toBe(base);
    expect(key('alice', { cardId: 'card-2' })).not.toBe(base);
    expect(key('bob')).not.toBe(base);
    expect(key('alice', { action: 'other-action' })).not.toBe(base);
  });

  test('JSON encoding prevents delimiter-based key collisions', () => {
    const first = key('alice', {
      tenantId: 'tenant|conversation',
      conversationId: 'card',
    });
    const second = key('alice', {
      tenantId: 'tenant',
      conversationId: 'conversation|card',
    });

    expect(first).not.toBe(second);
  });

  test('missing or malformed key components fail closed', () => {
    expect(() =>
      key('alice', { tenantId: undefined as unknown as string }),
    ).toThrow('Zap ledger tenant id is invalid');
    expect(() => key('alice', { cardId: '' })).toThrow(
      'Zap ledger card id is invalid',
    );
    expect(() => key('alice', { action: 'submit\nZaps' })).toThrow(
      'Zap ledger action is invalid',
    );
  });

  test('the store contains hashes and outcome metadata, not raw Teams ids', async () => {
    const storePath = newStorePath();
    const ledger = new ZapLedger({ storePath });
    const entryKey = zapKey({
      tenantId: 'secret-tenant-id',
      conversationId: 'secret-conversation-id',
      cardId: 'secret-card-id',
      recipientId: 'secret-recipient-id',
      action: 'submitZaps',
    });
    await ledger.tryAcquire(entryKey);
    await ledger.markPaid(entryKey, 'hash-alice');

    const raw = fs.readFileSync(storePath, 'utf8');

    expect(raw).toContain(entryKey);
    expect(raw).toContain('hash-alice');
    expect(raw).not.toContain('secret-tenant-id');
    expect(raw).not.toContain('secret-conversation-id');
    expect(raw).not.toContain('secret-card-id');
    expect(raw).not.toContain('secret-recipient-id');
    expect(raw).not.toContain('adminkey');
    expect(raw).not.toContain('inkey');
  });

  test('corrupt JSON fails at startup instead of resetting the ledger', () => {
    const storePath = newStorePath();
    fs.writeFileSync(storePath, '{invalid-json', { mode: 0o600 });

    expect(() => new ZapLedger({ storePath })).toThrow(
      'Zap ledger data could not be read',
    );
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{invalid-json');
  });

  test('unexpected persisted wallet data is rejected', () => {
    const storePath = newStorePath();
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        records: {
          [key('alice')]: {
            state: 'processing',
            at: 1,
            wallet: { adminkey: 'must-not-persist' },
          },
        },
      }),
      { mode: 0o600 },
    );

    expect(() => new ZapLedger({ storePath })).toThrow(
      'Zap ledger unsettled entry is invalid',
    );
  });

  test('production and Azure require an explicit absolute data directory', () => {
    const workingDirectory = path.resolve('working-directory');
    const durableDirectory = path.resolve(workingDirectory, 'durable-data');
    expect(() =>
      resolveZapLedgerStorePath({ NODE_ENV: 'production' }, workingDirectory),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(() =>
      resolveZapLedgerStorePath(
        { WEBSITE_INSTANCE_ID: 'azure-instance' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(() =>
      resolveZapLedgerStorePath(
        { NODE_ENV: 'production', ZAPLIE_DATA_DIR: 'relative-data' },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR must be an absolute durable path');
    expect(() =>
      resolveZapLedgerStorePath(
        {
          NODE_ENV: 'development',
          WEBSITE_SITE_NAME: 'azure-site',
        },
        workingDirectory,
      ),
    ).toThrow('ZAPLIE_DATA_DIR is required');
    expect(
      resolveZapLedgerStorePath(
        {
          NODE_ENV: 'production',
          ZAPLIE_DATA_DIR: durableDirectory,
        },
        workingDirectory,
      ),
    ).toBe(path.join(durableDirectory, 'bot-zap-ledger.json'));
  });

  test('only explicit development mode receives the ignored local fallback', () => {
    const workingDirectory = path.resolve('working-directory');
    expect(
      resolveZapLedgerStorePath({ NODE_ENV: 'development' }, workingDirectory),
    ).toBe(path.join(workingDirectory, '.zaplie-data', 'bot-zap-ledger.json'));
    expect(() => resolveZapLedgerStorePath({}, workingDirectory)).toThrow(
      ZapLedgerError,
    );
  });
});
