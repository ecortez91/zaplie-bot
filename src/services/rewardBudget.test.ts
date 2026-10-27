import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {
  getRewardBudget,
  resolveBudget,
  RewardBudgetError,
  RewardBudgetLedger,
} from './rewardBudget';
import { getRewardConfig } from './fetchRewardPolicy';
import { RewardError } from './rewardsService';

jest.mock('./fetchRewardPolicy', () => ({ getRewardConfig: jest.fn() }));
const mockedGetRewardConfig = getRewardConfig as unknown as jest.Mock<
  () => Promise<unknown>
>;

const key = (n: number): string => n.toString(16).padStart(64, '0');
const WEEK = 'week:2026-W44';

let directory: string;
let storePath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-budget-'));
  storePath = path.join(directory, 'bot-reward-budget.json');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('RewardBudgetLedger', () => {
  test('reserves up to the cap and refuses the reward that would cross it', async () => {
    const ledger = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await expect(ledger.reserve(WEEK, key(1), 600, 1000)).resolves.toBe(
      'reserved',
    );
    await expect(ledger.reserve(WEEK, key(2), 600, 1000)).resolves.toBe(
      'exceeded',
    );
    await expect(ledger.reserve(WEEK, key(3), 400, 1000)).resolves.toBe(
      'reserved',
    );
    await expect(ledger.spent(WEEK)).resolves.toBe(1000);
  });

  test('the same ledger key never counts twice', async () => {
    const ledger = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await ledger.reserve(WEEK, key(1), 600, 1000);
    await expect(ledger.reserve(WEEK, key(1), 600, 1000)).resolves.toBe(
      'reserved',
    );
    await expect(ledger.spent(WEEK)).resolves.toBe(600);
  });

  test('a new period starts from zero', async () => {
    const ledger = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await ledger.reserve(WEEK, key(1), 1000, 1000);
    await expect(
      ledger.reserve('week:2026-W45', key(2), 1000, 1000),
    ).resolves.toBe('reserved');
  });

  test('release frees the reservation, and releasing twice is harmless', async () => {
    const ledger = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await ledger.reserve(WEEK, key(1), 1000, 1000);
    await ledger.release(WEEK, key(1));
    await ledger.release(WEEK, key(1));
    await ledger.release('week:2026-W01', key(9));

    await expect(ledger.spent(WEEK)).resolves.toBe(0);
  });

  test('survives a restart', async () => {
    await new RewardBudgetLedger({ storePath }).reserve(
      WEEK,
      key(1),
      700,
      1000,
    );

    const reopened = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await expect(reopened.reserve(WEEK, key(2), 400, 1000)).resolves.toBe(
      'exceeded',
    );
  });

  test('two concurrent ledgers cannot both pass the cap', async () => {
    // Two instances share only the file and its lock, like two processes.
    const first = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });
    const second = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? first : second).reserve(WEEK, key(i + 1), 300, 1000),
      ),
    );

    expect(outcomes.filter(outcome => outcome === 'reserved')).toHaveLength(3);
    await expect(first.spent(WEEK)).resolves.toBe(900);
  });

  test('periods older than the retention window are pruned on write', async () => {
    let now = Date.parse('2025-01-10T00:00:00Z');
    const ledger = new RewardBudgetLedger({
      storePath,
      lockRetryMs: 1,
      now: () => now,
    });
    await ledger.reserve('month:2025-01', key(1), 5, 10);

    now = Date.parse('2026-10-28T00:00:00Z');
    await ledger.reserve(WEEK, key(2), 5, 10);

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    expect(Object.keys(stored.periods)).toEqual([WEEK]);
  });

  test.each([
    ['a bad period', 'day:2026-10-28', key(1), 5, 10],
    ['a bad key', WEEK, 'not-a-hash', 5, 10],
    ['a zero amount', WEEK, key(1), 0, 10],
    ['a zero cap', WEEK, key(1), 5, 0],
  ])('refuses %s', async (_label, period, ledgerKey, sats, cap) => {
    const ledger = new RewardBudgetLedger({ storePath, lockRetryMs: 1 });

    await expect(
      ledger.reserve(period, ledgerKey, sats, cap),
    ).rejects.toBeInstanceOf(RewardBudgetError);
  });

  test('a corrupt store stops the bot at startup', () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        periods: { [WEEK]: { reservations: { x: 1 } } },
      }),
    );

    expect(() => new RewardBudgetLedger({ storePath })).toThrow(
      RewardBudgetError,
    );
  });

  test('a store from a newer bot is refused, not overwritten', () => {
    fs.writeFileSync(storePath, JSON.stringify({ version: 2, periods: {} }));

    expect(() => new RewardBudgetLedger({ storePath })).toThrow(/newer/);
  });
});

describe('resolveBudget and getRewardBudget', () => {
  const names = [
    'REWARDS_BUDGET_PERIOD',
    'REWARDS_BUDGET_CAP_SATS',
    'REWARDS_BUDGET_TIMEZONE',
  ] as const;
  const saved = names.map(name => process.env[name]);
  const portal = {
    period: 'week' as const,
    capSats: 50000,
    timezone: 'Europe/London',
  };

  beforeEach(() => {
    names.forEach(name => delete process.env[name]);
  });

  afterEach(() => {
    names.forEach((name, i) => {
      if (saved[i] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[i];
      }
    });
  });

  test('no budget anywhere is a 503: nothing pays', () => {
    expect(() => resolveBudget(null)).toThrow(RewardError);
    try {
      resolveBudget(null);
    } catch (error) {
      expect((error as RewardError).statusCode).toBe(503);
    }
  });

  test('the portal budget applies when the environment sets nothing', () => {
    expect(resolveBudget(portal)).toEqual(portal);
  });

  test('each environment variable wins over the portal for its field', () => {
    process.env.REWARDS_BUDGET_CAP_SATS = '20000';

    expect(resolveBudget(portal)).toEqual({ ...portal, capSats: 20000 });
  });

  test('a partial environment without a portal budget is still not configured', () => {
    process.env.REWARDS_BUDGET_CAP_SATS = '20000';

    expect(() => resolveBudget(null)).toThrow('reward budget not configured');
  });

  test.each([
    ['REWARDS_BUDGET_PERIOD', 'day'],
    ['REWARDS_BUDGET_CAP_SATS', '1e3'],
    ['REWARDS_BUDGET_CAP_SATS', '0'],
    ['REWARDS_BUDGET_TIMEZONE', 'Mars/Base'],
  ])('a malformed %s=%s fails closed', (name, value) => {
    process.env[name] = value;

    expect(() => resolveBudget(portal)).toThrow(name);
  });

  test('a complete environment budget skips the portal read', async () => {
    process.env.REWARDS_BUDGET_PERIOD = 'month';
    process.env.REWARDS_BUDGET_CAP_SATS = '100000';
    process.env.REWARDS_BUDGET_TIMEZONE = 'UTC';

    await expect(getRewardBudget()).resolves.toEqual({
      period: 'month',
      capSats: 100000,
      timezone: 'UTC',
    });
    expect(mockedGetRewardConfig).not.toHaveBeenCalled();
  });

  test('otherwise the portal policy budget is read', async () => {
    mockedGetRewardConfig.mockResolvedValue({
      rewardAmounts: {},
      rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: portal },
    });

    await expect(getRewardBudget()).resolves.toEqual(portal);
  });

  test('a portal with no budget is a 503', async () => {
    mockedGetRewardConfig.mockResolvedValue({
      rewardAmounts: {},
      rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
    });

    await expect(getRewardBudget()).rejects.toMatchObject({ statusCode: 503 });
  });
});
