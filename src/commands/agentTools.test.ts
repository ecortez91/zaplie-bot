// agentTools.test.ts
//
// Mocks lnbitsService/zapHistoryService (external dependencies), not
// agentTools itself.

import { createReadOnlyTools } from './agentTools';
import { getUserWallets } from '../services/lnbitsService';
import {
  getZapActivity,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  afterEach,
  expect,
  describe,
  test,
  beforeEach,
  jest,
} from '@jest/globals';
import { TurnContext } from 'botbuilder';

jest.mock('../services/lnbitsService');
jest.mock('../services/zapHistoryService');
jest.mock('../services/graphService');

const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetZapActivity = getZapActivity as jest.MockedFunction<
  typeof getZapActivity
>;

// getZapActivity reports both the zaps and how complete the read was; most
// tests only care about the zaps.
const activityResult = (
  zaps: ZapActivityForTest[],
  coverage: Partial<{
    partial: boolean;
    skippedUsers: number;
    skippedWallets: number;
    truncated: boolean;
  }> = {},
) => ({
  zaps,
  partial: false,
  skippedUsers: 0,
  skippedWallets: 0,
  truncated: false,
  ...coverage,
});

type ZapActivityForTest = Awaited<
  ReturnType<typeof getZapActivity>
>['zaps'][number];

const leaderboardResult = (
  entries: Awaited<ReturnType<typeof getZapLeaderboard>>['entries'],
  coverage: Partial<{
    partial: boolean;
    skippedUsers: number;
    skippedWallets: number;
    truncated: boolean;
  }> = {},
) => ({
  entries,
  partial: false,
  skippedUsers: 0,
  skippedWallets: 0,
  truncated: false,
  ...coverage,
});
const mockGetZapLeaderboard = getZapLeaderboard as jest.MockedFunction<
  typeof getZapLeaderboard
>;
const mockGetRecentMeetings = getRecentMeetings as jest.MockedFunction<
  typeof getRecentMeetings
>;
const mockGetRelevantPeople = getRelevantPeople as jest.MockedFunction<
  typeof getRelevantPeople
>;

const currentUser: User = {
  id: 'user-1',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const makeTurnContext = (user: User | undefined): TurnContext => {
  const turnState = new Map<string, unknown>();
  if (user) turnState.set('user', user);
  return { turnState } as unknown as TurnContext;
};

const wallet = (overrides: Partial<Wallet>): Wallet => ({
  id: 'w1',
  admin: '',
  name: 'Allowance',
  user: 'user-1',
  adminkey: '',
  inkey: '',
  balance_msat: 0,
  deleted: false,
  ...overrides,
});

describe('agentTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get_my_balance', () => {
    test('returns only Allowance and Private balances in sats', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'Allowance', balance_msat: 900000 }),
        wallet({ name: 'LNbits wallet', balance_msat: 3000000 }),
        wallet({ name: 'Private', balance_msat: 50000 }),
      ]);

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_my_balance',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.wallets).toEqual([
        { name: 'Allowance', balanceSats: 900 },
        { name: 'Private', balanceSats: 50 },
      ]);
    });

    test('matches wallet names case-insensitively, as LNbits echoes them back', async () => {
      mockGetUserWallets.mockResolvedValue([
        wallet({ name: 'allowance', balance_msat: 900000 }),
        wallet({ name: 'PRIVATE', balance_msat: 50000 }),
      ]);

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_my_balance',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.wallets.map((w: { name: string }) => w.name)).toEqual([
        'allowance',
        'PRIVATE',
      ]);
    });
  });

  describe('get_leaderboard', () => {
    test('reports sats zapped out of Allowance wallets, never wallet balances', async () => {
      mockGetZapLeaderboard.mockResolvedValue(
        leaderboardResult([
          {
            user: { ...currentUser, id: 'user-alice', displayName: 'Alice' },
            zappedSats: 1500,
          },
          {
            user: { ...currentUser, id: 'user-bob', displayName: 'Bob' },
            zappedSats: 500,
          },
        ]),
      );

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.leaderboard).toEqual([
        { displayName: 'Alice', zappedSats: 1500 },
        { displayName: 'Bob', zappedSats: 500 },
      ]);
      expect(result.partial).toBe(false);
      expect(result.incompleteReason).toBeUndefined();
      expect(mockGetUserWallets).not.toHaveBeenCalled();
    });

    test('accepts a days window and passes the cut-off through', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;

      // The tool must advertise the parameter, or the model cannot answer
      // "who zapped most this week" with anything but all-time totals.
      expect(tool.parameters.properties).toHaveProperty('days');

      const before = Math.floor(Date.now() / 1000);
      const result: any = await tool.handler(
        { days: 7 },
        makeTurnContext(currentUser),
      );
      const after = Math.floor(Date.now() / 1000);

      const since = mockGetZapLeaderboard.mock.calls[0][0]!.sinceTimestamp!;
      expect(since).toBeGreaterThanOrEqual(before - 7 * 86400);
      expect(since).toBeLessThanOrEqual(after - 7 * 86400);
      expect(result.periodDays).toBe(7);
    });

    test('defaults to all-time when days is omitted, and caps it at 365', async () => {
      mockGetZapLeaderboard.mockResolvedValue(leaderboardResult([]));
      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;

      const allTime: any = await tool.handler({}, makeTurnContext(currentUser));
      expect(mockGetZapLeaderboard).toHaveBeenLastCalledWith({
        sinceTimestamp: undefined,
      });
      expect(allTime.periodDays).toBeNull();

      await tool.handler({ days: 10000 }, makeTurnContext(currentUser));
      const since = mockGetZapLeaderboard.mock.calls[1][0]!.sinceTimestamp!;
      expect(Math.floor(Date.now() / 1000) - since).toBeLessThanOrEqual(
        366 * 86400,
      );
    });

    test('flags an incomplete read so the assistant can hedge', async () => {
      mockGetZapLeaderboard.mockResolvedValue(
        leaderboardResult(
          [
            {
              user: { ...currentUser, id: 'user-alice', displayName: 'Alice' },
              zappedSats: 1500,
            },
          ],
          { partial: true, skippedUsers: 1, skippedWallets: 2 },
        ),
      );

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_leaderboard',
      )!;
      const result: any = await tool.handler({}, makeTurnContext(currentUser));

      expect(result.partial).toBe(true);
      expect(result.incompleteReason).toContain('incomplete');
      expect(result.incompleteReason).toContain('1 user(s)');
      expect(result.incompleteReason).toContain('2 wallet(s)');
    });
  });

  describe('get_recent_activity', () => {
    test('passes limit and onlyInvolvingMe through to getZapActivity', async () => {
      mockGetZapActivity.mockResolvedValue(
        activityResult([
          {
            from: { ...currentUser, displayName: 'Alice' },
            to: { ...currentUser, displayName: 'Bob' },
            amountSats: 100,
            memo: 'Great work!',
            time: new Date('2026-07-15T10:00:00Z'),
          },
        ]),
      );

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_recent_activity',
      )!;
      const result: any = await tool.handler(
        { limit: 10, onlyInvolvingMe: true },
        makeTurnContext(currentUser),
      );

      expect(mockGetZapActivity).toHaveBeenCalledWith({
        limit: 10,
        userAadObjectId: 'aad-alice',
      });
      expect(result.activity).toEqual([
        {
          from: 'Alice',
          to: 'Bob',
          amountSats: 100,
          memo: 'Great work!',
          time: '2026-07-15T10:00:00.000Z',
        },
      ]);
    });

    test('clamps limit to [1, 50] and defaults to 20', async () => {
      mockGetZapActivity.mockResolvedValue(activityResult([]));

      const tool = createReadOnlyTools().find(
        t => t.name === 'get_recent_activity',
      )!;

      await tool.handler({ limit: 500 }, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 50,
        userAadObjectId: undefined,
      });

      // A negative limit must not flow through to Array.prototype.slice,
      // where slice(0, -1) would return almost everything instead of a
      // small capped list.
      await tool.handler({ limit: -1 }, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 1,
        userAadObjectId: undefined,
      });

      await tool.handler({}, makeTurnContext(currentUser));
      expect(mockGetZapActivity).toHaveBeenLastCalledWith({
        limit: 20,
        userAadObjectId: undefined,
      });
    });
  });

  describe('Microsoft Graph tools', () => {
    const originalConnectionName = process.env.GRAPH_CONNECTION_NAME;

    const makeGraphContext = (token?: string): TurnContext => {
      const userTokenClientKey = Symbol('UserTokenClientKey');
      const turnState = new Map<unknown, unknown>();
      turnState.set(userTokenClientKey, {
        getUserToken: jest
          .fn<() => Promise<{ token: string } | undefined>>()
          .mockResolvedValue(token ? { token } : undefined),
      });
      return {
        turnState,
        adapter: { UserTokenClientKey: userTokenClientKey },
        activity: { from: { id: 'teams-user' }, channelId: 'msteams' },
      } as unknown as TurnContext;
    };

    beforeEach(() => {
      process.env.GRAPH_CONNECTION_NAME = 'GraphWorkSignals';
    });

    afterEach(() => {
      if (originalConnectionName === undefined) {
        delete process.env.GRAPH_CONNECTION_NAME;
      } else {
        process.env.GRAPH_CONNECTION_NAME = originalConnectionName;
      }
    });

    test('uses delegated tokens and clamps the meeting look-back window', async () => {
      mockGetRecentMeetings.mockResolvedValue([]);
      const tool = createReadOnlyTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      await expect(
        tool.handler({ days: 90 }, makeGraphContext('graph-token')),
      ).resolves.toEqual({ connected: true, periodDays: 30, meetings: [] });
      expect(mockGetRecentMeetings).toHaveBeenCalledWith('graph-token', 30);
    });

    test('returns a connection instruction instead of calling Graph without a token', async () => {
      const tool = createReadOnlyTools().find(
        item => item.name === 'get_recent_meetings',
      )!;

      const result: any = await tool.handler({}, makeGraphContext());

      expect(result).toMatchObject({ connected: false });
      expect(result.message).toMatch(/connect calendar/);
      expect(mockGetRecentMeetings).not.toHaveBeenCalled();
    });

    test('returns relevant collaborators without exposing message content', async () => {
      mockGetRelevantPeople.mockResolvedValue([
        { name: 'Ada', email: 'ada@zaplie.test' },
      ]);
      const tool = createReadOnlyTools().find(
        item => item.name === 'get_frequent_collaborators',
      )!;

      await expect(
        tool.handler({}, makeGraphContext('graph-token')),
      ).resolves.toEqual({
        connected: true,
        collaborators: [{ name: 'Ada', email: 'ada@zaplie.test' }],
      });
    });

    test('does not register Graph tools when the connection is disabled', () => {
      delete process.env.GRAPH_CONNECTION_NAME;

      expect(createReadOnlyTools().map(tool => tool.name)).not.toContain(
        'get_recent_meetings',
      );
    });
  });
});
