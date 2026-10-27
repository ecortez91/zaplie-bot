import * as fs from 'fs';
import * as path from 'path';
import { DataDirError, resolveDataDir } from './dataDir';
import {
  ensureDataDirectory,
  isErrnoException,
  LedgerFile,
  recoverStaleLock,
  resolveStaleLockMs,
  sweepStaleTemporaries,
  validateDuration,
  withStoreLock,
  writeAtomically,
} from './ledgerFile';
import {
  BudgetPeriod,
  PERIOD_KEY_PATTERN,
  periodStartMs,
} from './rewardPeriod';
import { getRewardConfig, RewardBudget } from './fetchRewardPolicy';
import { RewardError } from './rewardsService';

const STORE_VERSION = 1;
const STORE_FILENAME = 'bot-reward-budget.json';
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
// Periods older than this are dropped on write: a monthly budget needs at
// most the current month, and a year of history is plenty for an audit.
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type BudgetReservation = 'reserved' | 'exceeded';

interface BudgetPeriodRecord {
  reservations: Record<string, number>;
}

interface BudgetStore {
  version: typeof STORE_VERSION;
  periods: Record<string, BudgetPeriodRecord>;
}

export interface RewardBudgetLedgerOptions {
  storePath?: string;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  // At startup a lock file older than this is removed as crash-left. Defaults
  // to ZAPLIE_LEDGER_STALE_LOCK_MS, else 30 s. 0 disables it.
  staleLockMs?: number;
  now?: () => number;
}

export class RewardBudgetError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RewardBudgetError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const validateStore = (value: unknown): BudgetStore => {
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    value.version > STORE_VERSION
  ) {
    throw new RewardBudgetError(
      `Reward budget ledger was written by a newer version of the bot ` +
        `(store version ${value.version}); do not delete it, it records spend`,
    );
  }
  if (
    !isRecord(value) ||
    value.version !== STORE_VERSION ||
    !isRecord(value.periods) ||
    Object.keys(value).sort().join(',') !== 'periods,version'
  ) {
    throw new RewardBudgetError('Reward budget ledger data is invalid');
  }
  const periods: Record<string, BudgetPeriodRecord> = {};
  for (const [periodKey, record] of Object.entries(value.periods)) {
    if (
      !PERIOD_KEY_PATTERN.test(periodKey) ||
      !isRecord(record) ||
      Object.keys(record).join(',') !== 'reservations' ||
      !isRecord(record.reservations)
    ) {
      throw new RewardBudgetError('Reward budget ledger period is invalid');
    }
    const reservations: Record<string, number> = {};
    for (const [key, sats] of Object.entries(record.reservations)) {
      if (!HASH_PATTERN.test(key) || !isAmount(sats)) {
        throw new RewardBudgetError(
          'Reward budget ledger reservation is invalid',
        );
      }
      reservations[key] = sats;
    }
    periods[periodKey] = { reservations };
  }
  return { version: STORE_VERSION, periods };
};

const readStore = (storePath: string): BudgetStore => {
  try {
    return validateStore(JSON.parse(fs.readFileSync(storePath, 'utf8')));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { version: STORE_VERSION, periods: {} };
    }
    if (error instanceof RewardBudgetError) {
      throw error;
    }
    throw new RewardBudgetError(
      'Reward budget ledger data could not be read',
      error,
    );
  }
};

const sum = (reservations: Record<string, number>): number =>
  Object.values(reservations).reduce((total, sats) => total + sats, 0);

/**
 * Path of `bot-reward-budget.json` under ZAPLIE_DATA_DIR.
 *
 * @throws RewardBudgetError when ZAPLIE_DATA_DIR is missing or not absolute
 *   outside explicit development mode
 */
export const resolveRewardBudgetStorePath = (
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): string => {
  try {
    return path.join(
      resolveDataDir(environment, workingDirectory),
      STORE_FILENAME,
    );
  } catch (error) {
    if (error instanceof DataDirError) {
      throw new RewardBudgetError(error.message, error);
    }
    throw error;
  }
};

/**
 * The aggregate reward budget: what each period has committed, keyed by the
 * same ledger key as the idempotency ledger, so a replay never counts twice.
 * Same storage contract as the reward ledger (one JSON file under
 * ZAPLIE_DATA_DIR, an exclusive lock, atomic replacement).
 *
 * A reservation is kept for paid, pending and uncertain rewards. It is only
 * released for a failure known to be before the payment left the bot.
 */
export class RewardBudgetLedger {
  readonly storePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly now: () => number;
  private readonly file: LedgerFile;

  /**
   * @throws RewardBudgetError when the data directory or store is invalid,
   *   so the bot fails at startup rather than mid-payment
   */
  constructor(options: RewardBudgetLedgerOptions = {}) {
    this.storePath = options.storePath ?? resolveRewardBudgetStorePath();
    this.lockPath = `${this.storePath}.lock`;
    const lockRetryMs = validateDuration(
      RewardBudgetError,
      'Reward budget lock retry duration',
      options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    );
    this.lockTimeoutMs = validateDuration(
      RewardBudgetError,
      'Reward budget lock timeout',
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    );
    const staleLockMs = resolveStaleLockMs(
      RewardBudgetError,
      'Reward budget stale lock threshold',
      options.staleLockMs,
    );
    this.now = options.now ?? Date.now;
    this.file = {
      storePath: this.storePath,
      lockPath: this.lockPath,
      label: 'Reward budget ledger',
      lockTimeoutImpact: 'every reward request fails',
      lockRetryMs,
      errorType: RewardBudgetError,
      activityChannel: 'api',
    };
    ensureDataDirectory(this.file);
    sweepStaleTemporaries(this.storePath, this.now());
    // Same startup lock recovery as the zap ledger; records are untouched.
    recoverStaleLock(this.file, this.now(), staleLockMs);
    readStore(this.storePath);
  }

  /**
   * Check-and-add under the lock: reserves `sats` in the period unless that
   * would take the period's total above `capSats`. Reserving the same ledger
   * key again in the same period is a no-op that answers `reserved`.
   */
  async reserve(
    periodKey: string,
    ledgerKey: string,
    sats: number,
    capSats: number,
  ): Promise<BudgetReservation> {
    this.validate(periodKey, ledgerKey);
    if (!isAmount(sats) || !isAmount(capSats)) {
      throw new RewardBudgetError('Reward budget amount is invalid');
    }
    return withStoreLock(
      this.file,
      async () => {
        const store = readStore(this.storePath);
        const record = store.periods[periodKey] ?? { reservations: {} };
        if (record.reservations[ledgerKey] !== undefined) {
          return 'reserved';
        }
        if (sum(record.reservations) + sats > capSats) {
          return 'exceeded';
        }
        record.reservations[ledgerKey] = sats;
        store.periods[periodKey] = record;
        await this.writeStore(store);
        return 'reserved';
      },
      this.lockTimeoutMs,
    );
  }

  /**
   * Removes a reservation. Only for a reward known not to have paid: a
   * failure before the payment or pending-reward request left the bot.
   */
  async release(periodKey: string, ledgerKey: string): Promise<void> {
    this.validate(periodKey, ledgerKey);
    await withStoreLock(
      this.file,
      async () => {
        const store = readStore(this.storePath);
        const record = store.periods[periodKey];
        if (!record || record.reservations[ledgerKey] === undefined) {
          return;
        }
        delete record.reservations[ledgerKey];
        await this.writeStore(store);
      },
      this.lockTimeoutMs,
    );
  }

  /** Sats committed in the period so far. Lock-free: writes are atomic. */
  async spent(periodKey: string): Promise<number> {
    if (!PERIOD_KEY_PATTERN.test(periodKey)) {
      throw new RewardBudgetError('Reward budget period is invalid');
    }
    const record = readStore(this.storePath).periods[periodKey];
    return record ? sum(record.reservations) : 0;
  }

  private validate(periodKey: string, ledgerKey: string): void {
    if (!PERIOD_KEY_PATTERN.test(periodKey)) {
      throw new RewardBudgetError('Reward budget period is invalid');
    }
    if (!HASH_PATTERN.test(ledgerKey)) {
      throw new RewardBudgetError('Reward budget key is invalid');
    }
  }

  private async writeStore(store: BudgetStore): Promise<void> {
    const cutoff = this.now() - RETENTION_MS;
    for (const periodKey of Object.keys(store.periods)) {
      if (periodStartMs(periodKey) < cutoff) {
        delete store.periods[periodKey];
      }
    }
    const canonical = validateStore(store);
    await writeAtomically(this.file, `${JSON.stringify(canonical, null, 2)}\n`);
  }
}

const ENV_PERIOD = 'REWARDS_BUDGET_PERIOD';
const ENV_CAP = 'REWARDS_BUDGET_CAP_SATS';
const ENV_TIMEZONE = 'REWARDS_BUDGET_TIMEZONE';

const envValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

/**
 * The budget in force: each `REWARDS_BUDGET_*` variable that is set wins over
 * the portal's value for that field. All three must end up set.
 * tabs/backend/rewardBudget.js repeats this for the stats panel: change both.
 *
 * @throws RewardError 503 when no complete budget is configured anywhere
 * @throws Error when an environment value is malformed (a config error)
 */
export const resolveBudget = (portal: RewardBudget | null): RewardBudget => {
  const envPeriod = envValue(ENV_PERIOD);
  if (
    envPeriod !== undefined &&
    envPeriod !== 'week' &&
    envPeriod !== 'month'
  ) {
    throw new Error(`${ENV_PERIOD} must be week or month`);
  }
  const envCap = envValue(ENV_CAP);
  let cap: number | undefined;
  if (envCap !== undefined) {
    cap = /^\d+$/.test(envCap) ? Number.parseInt(envCap, 10) : Number.NaN;
    if (!isAmount(cap)) {
      throw new Error(`${ENV_CAP} must be a positive integer`);
    }
  }
  const envTimezone = envValue(ENV_TIMEZONE);
  if (envTimezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: envTimezone });
    } catch {
      throw new Error(`${ENV_TIMEZONE} must be an IANA time zone`);
    }
  }

  const period = (envPeriod as BudgetPeriod | undefined) ?? portal?.period;
  const capSats = cap ?? portal?.capSats;
  const timezone = envTimezone ?? portal?.timezone;
  if (period === undefined || capSats === undefined || timezone === undefined) {
    throw new RewardError('reward budget not configured', 503);
  }
  return { period, capSats, timezone };
};

/**
 * The budget for the next reward. The portal is read only when the
 * environment does not already set all three fields.
 *
 * @throws RewardError 503 when no budget is configured
 */
export const getRewardBudget = async (): Promise<RewardBudget> => {
  if (
    envValue(ENV_PERIOD) !== undefined &&
    envValue(ENV_CAP) !== undefined &&
    envValue(ENV_TIMEZONE) !== undefined
  ) {
    return resolveBudget(null);
  }
  const { rewardPolicy } = await getRewardConfig();
  return resolveBudget(rewardPolicy.budget);
};
