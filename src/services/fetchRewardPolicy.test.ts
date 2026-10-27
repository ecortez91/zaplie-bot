import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {
  getRewardConfig,
  parseRewardConfig,
  RewardPolicyInvalidError,
} from './fetchRewardPolicy';

const OID = '11111111-2222-3333-4444-555555555555';
const validBody = () => ({
  rewardAmounts: { githubPrMergedSats: 1000 },
  rewardPolicy: {
    version: 1,
    levels: {
      githubPrMerged: {
        labelPrefix: 'reward:',
        bonuses: { L1: 250, L2: 500, L3: 1000 },
      },
    },
    overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } },
    budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
  },
});

describe('parseRewardConfig', () => {
  test('accepts a valid policy', () => {
    expect(parseRewardConfig(validBody())).toEqual(validBody());
  });

  test('accepts an empty, unconfigured policy', () => {
    expect(
      parseRewardConfig({
        rewardAmounts: {},
        rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
      }),
    ).toEqual({
      rewardAmounts: {},
      rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
    });
  });

  const mutate = (change: (body: ReturnType<typeof validBody>) => void) => {
    const body = validBody();
    change(body);
    return body;
  };

  test.each([
    ['a missing policy', { rewardAmounts: {} }],
    [
      'an unknown amount key',
      mutate(b => Object.assign(b.rewardAmounts, { coffeeSats: 5 })),
    ],
    ['a zero amount', mutate(b => (b.rewardAmounts.githubPrMergedSats = 0))],
    [
      'a string amount',
      mutate(b =>
        Object.assign(b.rewardAmounts, { githubPrMergedSats: '1000' }),
      ),
    ],
    [
      'a newer policy version',
      mutate(b => Object.assign(b.rewardPolicy, { version: 2 })),
    ],
    [
      'an unknown policy key',
      mutate(b => Object.assign(b.rewardPolicy, { treasuries: {} })),
    ],
    [
      'a negative bonus',
      mutate(b => (b.rewardPolicy.levels.githubPrMerged.bonuses.L1 = -1)),
    ],
    [
      'a bad label prefix',
      mutate(b => (b.rewardPolicy.levels.githubPrMerged.labelPrefix = 'a b')),
    ],
    [
      'an unknown level event',
      mutate(b =>
        Object.assign(b.rewardPolicy.levels, {
          coffee: b.rewardPolicy.levels.githubPrMerged,
        }),
      ),
    ],
    [
      'a non-GUID override',
      mutate(b => Object.assign(b.rewardPolicy.overrides, { octocat: {} })),
    ],
    [
      'a fractional override',
      mutate(
        b => (b.rewardPolicy.overrides[OID].githubPrMerged.baseSats = 1.5),
      ),
    ],
    [
      'a daily budget',
      mutate(b => Object.assign(b.rewardPolicy.budget, { period: 'day' })),
    ],
    [
      'an unknown time zone',
      mutate(b =>
        Object.assign(b.rewardPolicy.budget, { timezone: 'Mars/Base' }),
      ),
    ],
    [
      'a zero budget',
      mutate(b => Object.assign(b.rewardPolicy.budget, { capSats: 0 })),
    ],
  ])('refuses %s', (_label, body) => {
    expect(() => parseRewardConfig(body)).toThrow(RewardPolicyInvalidError);
  });
});

describe('getRewardConfig', () => {
  const saved = {
    token: process.env.TAB_BACKEND_TOKEN,
    url: process.env.WEBSITE_API_URL,
  };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock<typeof fetch>;

  beforeEach(() => {
    process.env.TAB_BACKEND_TOKEN = 'test-token';
    process.env.WEBSITE_API_URL = 'https://portal.example/api/';
    fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const [name, value] of [
      ['TAB_BACKEND_TOKEN', saved.token],
      ['WEBSITE_API_URL', saved.url],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  test('reads /reward-policy with the shared token and validates it', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(validBody()), { status: 200 }),
    );

    await expect(getRewardConfig()).resolves.toEqual(validBody());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://portal.example/api/reward-policy',
      { headers: { Authorization: 'test-token' } },
    );
  });

  test('a portal error status throws, so nothing is paid', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));

    await expect(getRewardConfig()).rejects.toThrow(
      'reward policy fetch failed: 500',
    );
  });

  test('a malformed response throws', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ rewardAmounts: {} }), { status: 200 }),
    );

    await expect(getRewardConfig()).rejects.toThrow(RewardPolicyInvalidError);
  });
});
