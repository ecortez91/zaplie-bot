// zapHistoryService.test.ts
//
// Mocks lnbitsService (an external dependency of the module under test), not
// zapHistoryService itself — the matching/filtering logic being tested here
// lives entirely in zapHistoryService.

import {
  getRecentZaps,
  getZapLeaderboard,
  MAX_CONCURRENT_LNBITS_REQUESTS,
  PAYMENTS_PAGE_SIZE,
  getZapActivity,
} from './zapHistoryService';
import {
  getUsers,
  getUserWallets,
  getPayments,
  getAllPaymentsPage,
  PaginatedPaymentsUnsupportedError,
} from './lnbitsService';
import { expect, describe, test, beforeEach, jest } from '@jest/globals';

jest.mock('./lnbitsService');

const mockGetUsers = getUsers as jest.MockedFunction<typeof getUsers>;
const mockGetUserWallets = getUserWallets as jest.MockedFunction<
  typeof getUserWallets
>;
const mockGetPayments = getPayments as jest.MockedFunction<typeof getPayments>;
const mockGetAllPaymentsPage = getAllPaymentsPage as jest.MockedFunction<
  typeof getAllPaymentsPage
>;

// Every payment on the instance, which is what the paginated endpoint returns:
// the union of the per-wallet fixtures, each row appearing once.
const allFixturePayments = (): Transaction[] =>
  Object.values(walletsByInkey).reduce<Transaction[]>(
    (rows, walletRows) => rows.concat(walletRows),
    [],
  );

// Force the per-wallet fallback: the instance has no paginated all-payments
// endpoint, or these credentials may not read it. The error is built from the
// mocked class so the `instanceof` check in the module under test still sees it
// as the availability signal rather than a real failure.
const useWalletFallback = () => {
  mockGetAllPaymentsPage.mockRejectedValue(
    new PaginatedPaymentsUnsupportedError(404),
  );
};

const alice: User = {
  id: 'user-alice',
  displayName: 'Alice',
  profileImg: '',
  aadObjectId: 'aad-alice',
  email: 'alice@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const bob: User = {
  id: 'user-bob',
  displayName: 'Bob',
  profileImg: '',
  aadObjectId: 'aad-bob',
  email: 'bob@example.com',
  privateWallet: null,
  allowanceWallet: null,
};

const aliceAllowance: Wallet = {
  id: 'w-alice-allow',
  admin: '',
  name: 'Allowance',
  user: alice.id,
  adminkey: 'adm-alice-allow',
  inkey: 'ink-alice-allow',
  balance_msat: 900000,
  deleted: false,
};

const alicePrivate: Wallet = {
  id: 'w-alice-priv',
  admin: '',
  name: 'Private',
  user: alice.id,
  adminkey: 'adm-alice-priv',
  inkey: 'ink-alice-priv',
  balance_msat: 0,
  deleted: false,
};

const bobAllowance: Wallet = {
  id: 'w-bob-allow',
  admin: '',
  name: 'Allowance',
  user: bob.id,
  adminkey: 'adm-bob-allow',
  inkey: 'ink-bob-allow',
  balance_msat: 1000000,
  deleted: false,
};

const bobPrivate: Wallet = {
  id: 'w-bob-priv',
  admin: '',
  name: 'Private',
  user: bob.id,
  adminkey: 'adm-bob-priv',
  inkey: 'ink-bob-priv',
  balance_msat: 100000,
  deleted: false,
};

const walletsByInkey: Record<string, Transaction[]> = {};

const setupUsersAndWallets = () => {
  mockGetUsers.mockResolvedValue([alice, bob]);
  mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
    if (userId === alice.id) return [aliceAllowance, alicePrivate];
    if (userId === bob.id) return [bobAllowance, bobPrivate];
    return [];
  });
  mockGetPayments.mockImplementation(
    async (inKey: string, _limit?: number, offset = 0) =>
      // One short page: the fixtures are far smaller than a page, so paging
      // stops after the first read.
      offset === 0 ? walletsByInkey[inKey] || [] : [],
  );
  // Default to the primary path — one paginated read of every payment.
  mockGetAllPaymentsPage.mockImplementation(async (_limit, offset) =>
    offset === 0 ? allFixturePayments() : [],
  );
};

const tx = (overrides: Partial<Transaction>): Transaction => ({
  checking_id: 'default',
  pending: false,
  amount: 0,
  fee: 0,
  memo: '',
  time: 0,
  extra: {},
  wallet_id: '',
  ...overrides,
});

describe('zapHistoryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  test('matches a zap across the Allowance (debit) and Private (credit) sides by checking_id', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      amountSats: 100,
      memo: 'Great work!',
    });
    expect(result[0].from?.displayName).toBe('Alice');
    expect(result[0].to?.displayName).toBe('Bob');
  });

  test('excludes scheduled "Weekly Allowance cleared" sweeps', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'sweep1',
        amount: -50000,
        memo: 'Weekly Allowance cleared',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_sweep1',
        amount: 50000,
        memo: 'Weekly Allowance cleared',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(0);
  });

  test('excludes outgoing Allowance payments with no matching Private-wallet receipt', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'external1',
        amount: -30000,
        memo: 'External lightning payment',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];

    const result = await getRecentZaps();

    expect(result).toHaveLength(0);
  });

  test('deduplicates a single zap seen from both the debit and credit wallet fetch', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        memo: 'Thanks!',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        memo: 'Thanks!',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [];
    walletsByInkey[bobAllowance.inkey] = [];

    const result = await getRecentZaps();

    expect(result).toHaveLength(1);
  });

  test('filters out zaps before sinceTimestamp', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'old-zap',
        amount: -10000,
        memo: 'old',
        time: 1000000000,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'new-zap',
        amount: -20000,
        memo: 'new',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_old-zap',
        amount: 10000,
        memo: 'old',
        time: 1000000000,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_new-zap',
        amount: 20000,
        memo: 'new',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps({ sinceTimestamp: 1700000000 });

    expect(result).toHaveLength(1);
    expect(result[0].memo).toBe('new');
  });

  test('filters to zaps involving a specific user as either sender or receiver', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'a-to-b',
        amount: -10000,
        memo: 'alice to bob',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobAllowance.inkey] = [
      tx({
        checking_id: 'b-to-a',
        amount: -20000,
        memo: 'bob to alice',
        time: 1750000001,
        wallet_id: bobAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_a-to-b',
        amount: 10000,
        memo: 'alice to bob',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [
      tx({
        checking_id: 'internal_b-to-a',
        amount: 20000,
        memo: 'bob to alice',
        time: 1750000001,
        wallet_id: alicePrivate.id,
      }),
    ];

    const result = await getRecentZaps({ userAadObjectId: bob.aadObjectId });

    expect(result).toHaveLength(2);
  });

  test('sorts newest first and respects limit', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'z1',
        amount: -1000,
        memo: 'first',
        time: 100,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'z2',
        amount: -1000,
        memo: 'second',
        time: 200,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'z3',
        amount: -1000,
        memo: 'third',
        time: 300,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_z1',
        amount: 1000,
        memo: 'first',
        time: 100,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_z2',
        amount: 1000,
        memo: 'second',
        time: 200,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_z3',
        amount: 1000,
        memo: 'third',
        time: 300,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getRecentZaps({ limit: 2 });

    expect(result).toHaveLength(2);
    expect(result[0].memo).toBe('third');
    expect(result[1].memo).toBe('second');
  });

  test('returns an empty array when there are no users', async () => {
    mockGetUsers.mockResolvedValue([]);

    const result = await getRecentZaps();

    expect(result).toEqual([]);
  });
});

describe('getZapLeaderboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  test('sums every zap a teammate sent out of their Allowance wallet, highest first', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'a1',
        amount: -100000,
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'a2',
        amount: -20000,
        time: 1750000001,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobAllowance.inkey] = [
      tx({
        checking_id: 'b1',
        amount: -50000,
        time: 1750000002,
        wallet_id: bobAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_a1',
        amount: 100000,
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_a2',
        amount: 20000,
        time: 1750000001,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [
      tx({
        checking_id: 'internal_b1',
        amount: 50000,
        time: 1750000002,
        wallet_id: alicePrivate.id,
      }),
    ];

    const result = await getZapLeaderboard();

    expect(
      result.entries.map(entry => [entry.user.displayName, entry.zappedSats]),
    ).toEqual([
      ['Alice', 120],
      ['Bob', 50],
    ]);
  });

  test('ignores sats received into a Private wallet', async () => {
    // Bob's Private wallet is his own money: a payment in from anywhere other
    // than a teammate's Allowance wallet must not put him on the leaderboard.
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'coffee-money',
        amount: 900000,
        memo: 'Sold a coffee',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'a1',
        amount: -10000,
        time: 1750000001,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [];
    walletsByInkey[bobAllowance.inkey] = [];

    const result = await getZapLeaderboard();

    expect(result.entries).toEqual([]);
    expect(result.partial).toBe(false);
  });

  test('breaks ties on display name so equal totals keep a stable order', async () => {
    walletsByInkey[bobAllowance.inkey] = [
      tx({
        checking_id: 'b1',
        amount: -10000,
        time: 1750000002,
        wallet_id: bobAllowance.id,
      }),
    ];
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'a1',
        amount: -10000,
        time: 1750000001,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[alicePrivate.inkey] = [
      tx({
        checking_id: 'internal_b1',
        amount: 10000,
        time: 1750000002,
        wallet_id: alicePrivate.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_a1',
        amount: 10000,
        time: 1750000001,
        wallet_id: bobPrivate.id,
      }),
    ];

    const result = await getZapLeaderboard();

    expect(result.entries.map(entry => entry.user.displayName)).toEqual([
      'Alice',
      'Bob',
    ]);
  });
});

describe('LNbits request fan-out', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
  });

  test('keeps in-flight wallet and payment reads under the concurrency cap', async () => {
    const teamSize = MAX_CONCURRENT_LNBITS_REQUESTS * 4;
    const users: User[] = Array.from(
      { length: teamSize },
      (_unused, index) => ({
        id: `user-${index}`,
        displayName: `User ${index}`,
        profileImg: '',
        aadObjectId: `aad-${index}`,
        email: `user${index}@example.com`,
        privateWallet: null,
        allowanceWallet: null,
      }),
    );

    let walletReadsInFlight = 0;
    let peakWalletReads = 0;
    let paymentReadsInFlight = 0;
    let peakPaymentReads = 0;

    mockGetUsers.mockResolvedValue(users);
    mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
      walletReadsInFlight += 1;
      peakWalletReads = Math.max(peakWalletReads, walletReadsInFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      walletReadsInFlight -= 1;
      return [
        {
          id: `w-${userId}-allow`,
          admin: '',
          name: 'Allowance',
          user: userId,
          adminkey: `adm-${userId}-allow`,
          inkey: `ink-${userId}-allow`,
          balance_msat: 0,
          deleted: false,
        },
        {
          id: `w-${userId}-priv`,
          admin: '',
          name: 'Private',
          user: userId,
          adminkey: `adm-${userId}-priv`,
          inkey: `ink-${userId}-priv`,
          balance_msat: 0,
          deleted: false,
        },
      ];
    });
    mockGetPayments.mockImplementation(async () => {
      paymentReadsInFlight += 1;
      peakPaymentReads = Math.max(peakPaymentReads, paymentReadsInFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      paymentReadsInFlight -= 1;
      return [];
    });
    // The pool matters on the fallback path, which is the one that still issues
    // a request per wallet.
    useWalletFallback();

    await getRecentZaps();

    expect(mockGetUserWallets).toHaveBeenCalledTimes(teamSize);
    expect(mockGetPayments).toHaveBeenCalledTimes(teamSize * 2);
    // Every wallet read must ask for a full page, or totals undercount.
    for (const call of mockGetPayments.mock.calls) {
      expect(call[1]).toBe(PAYMENTS_PAGE_SIZE);
    }
    expect(peakWalletReads).toBeLessThanOrEqual(MAX_CONCURRENT_LNBITS_REQUESTS);
    expect(peakPaymentReads).toBeLessThanOrEqual(
      MAX_CONCURRENT_LNBITS_REQUESTS,
    );
    // Still parallel, not one-at-a-time.
    expect(peakWalletReads).toBeGreaterThan(1);
    expect(peakPaymentReads).toBeGreaterThan(1);
  });
});

describe('incomplete reads are reported, never scored as zero', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  const aliceZapsBob = () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        memo: 'Great work!',
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
  };

  test('a failed wallet payment read flags partial instead of scoring zero', async () => {
    aliceZapsBob();
    useWalletFallback();
    // Bob's Allowance read fails; Alice's zap is still counted, but the result
    // must say the ranking is incomplete rather than assert Bob sent nothing.
    mockGetPayments.mockImplementation(async (inKey: string) => {
      if (inKey === bobAllowance.inkey) {
        throw new Error('429 Too Many Requests');
      }
      return walletsByInkey[inKey] || [];
    });

    const result = await getZapLeaderboard();

    expect(result.entries.map(e => e.user.displayName)).toEqual(['Alice']);
    expect(result.partial).toBe(true);
    expect(result.skippedWallets).toBe(1);
    expect(result.skippedUsers).toBe(0);
  });

  test('a failed user wallet read skips that user rather than rejecting', async () => {
    aliceZapsBob();
    mockGetUserWallets.mockImplementation(async (_adminKey, userId) => {
      if (userId === bob.id) throw new Error('500 Internal Server Error');
      return [aliceAllowance, alicePrivate];
    });

    const result = await getZapLeaderboard();

    expect(result.partial).toBe(true);
    expect(result.skippedUsers).toBe(1);
    // Bob's Private wallet is unknown, so the cross-reference cannot confirm
    // where the zap landed — the total is a floor, and says so.
    expect(result.entries.length).toBeLessThanOrEqual(1);
  });

  test('a complete read is not flagged partial', async () => {
    aliceZapsBob();

    const result = await getZapLeaderboard();

    expect(result.partial).toBe(false);
    expect(result.skippedUsers).toBe(0);
    expect(result.skippedWallets).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe('payment paging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  test('pages the instance-wide read until a short page comes back', async () => {
    // A zap whose receiving side sits beyond the first page. Before paging, the
    // receiver row was cut off, the checking_id cross-reference failed, and the
    // sender's zap vanished from the totals with nothing logged.
    const filler = (index: number) =>
      tx({
        checking_id: `filler-${index}`,
        amount: -1,
        time: 1749000000,
        wallet_id: alicePrivate.id,
      });
    const senderRow = tx({
      checking_id: 'zap-far',
      amount: -100000,
      memo: 'Thanks',
      time: 1750000000,
      wallet_id: aliceAllowance.id,
    });
    const receiverRow = tx({
      checking_id: 'internal_zap-far',
      amount: 100000,
      memo: 'Thanks',
      time: 1750000000,
      wallet_id: bobPrivate.id,
    });

    const firstPage = [
      senderRow,
      ...Array.from({ length: PAYMENTS_PAGE_SIZE - 1 }, (_u, i) => filler(i)),
    ];
    mockGetAllPaymentsPage.mockImplementation(async (_limit, offset) => {
      if (offset === 0) return firstPage;
      if (offset === PAYMENTS_PAGE_SIZE) return [receiverRow];
      return [];
    });

    const result = await getZapLeaderboard();

    expect(mockGetAllPaymentsPage).toHaveBeenCalledTimes(2);
    expect(result.entries.map(e => [e.user.displayName, e.zappedSats])).toEqual(
      [['Alice', 100]],
    );
    expect(result.partial).toBe(false);
  });

  test('reads every payment in one instance-wide call set, not one per wallet', async () => {
    walletsByInkey[aliceAllowance.inkey] = [];
    const result = await getZapActivity();

    expect(mockGetAllPaymentsPage).toHaveBeenCalledTimes(1);
    expect(mockGetPayments).not.toHaveBeenCalled();
    expect(result.partial).toBe(false);
  });

  test('falls back to per-wallet paging when the endpoint is unavailable', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'zap1',
        amount: -100000,
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_zap1',
        amount: 100000,
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];
    useWalletFallback();

    const result = await getZapLeaderboard();

    expect(mockGetPayments).toHaveBeenCalled();
    expect(result.entries.map(e => [e.user.displayName, e.zappedSats])).toEqual(
      [['Alice', 100]],
    );
    expect(result.partial).toBe(false);
  });

  test('a non-availability error is not swallowed by the fallback', async () => {
    mockGetAllPaymentsPage.mockRejectedValue(new Error('boom'));

    await expect(getZapLeaderboard()).rejects.toThrow('boom');
    expect(mockGetPayments).not.toHaveBeenCalled();
  });
});

describe('leaderboard period filter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(walletsByInkey)) {
      delete walletsByInkey[key];
    }
    setupUsersAndWallets();
  });

  test('counts only zaps sent after sinceTimestamp', async () => {
    walletsByInkey[aliceAllowance.inkey] = [
      tx({
        checking_id: 'old',
        amount: -500000,
        time: 1700000000,
        wallet_id: aliceAllowance.id,
      }),
      tx({
        checking_id: 'new',
        amount: -100000,
        time: 1750000000,
        wallet_id: aliceAllowance.id,
      }),
    ];
    walletsByInkey[bobPrivate.inkey] = [
      tx({
        checking_id: 'internal_old',
        amount: 500000,
        time: 1700000000,
        wallet_id: bobPrivate.id,
      }),
      tx({
        checking_id: 'internal_new',
        amount: 100000,
        time: 1750000000,
        wallet_id: bobPrivate.id,
      }),
    ];

    const allTime = await getZapLeaderboard();
    expect(allTime.entries[0].zappedSats).toBe(600);

    const recent = await getZapLeaderboard({ sinceTimestamp: 1740000000 });
    expect(recent.entries.map(e => [e.user.displayName, e.zappedSats])).toEqual(
      [['Alice', 100]],
    );
  });
});
