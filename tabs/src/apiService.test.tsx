import axios from 'axios';
import {
  MAX_REWARD_NAME_LENGTH,
  RewardNameError,
  getAutomations,
  getPeople,
  getRewardAmounts,
  getRewardName,
  getRewardPolicy,
  parsePeopleResponse,
  parseRewardPolicyResponse,
  updateAutomations,
  updateRewardAmounts,
  updateRewardName,
  updateRewardPolicy,
} from './apiService';

jest.mock('axios');

const mockGet = jest.mocked(axios.get);
const mockPost = jest.mocked(axios.post);

describe('reward name API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns a trimmed non-empty reward name', async () => {
    mockGet.mockResolvedValue({ data: { rewardName: '  Sats  ' } });

    await expect(getRewardName()).resolves.toEqual({ rewardName: 'Sats' });
  });

  test.each([
    undefined,
    null,
    {},
    { rewardName: '' },
    { rewardName: '   ' },
    { rewardName: 20 },
  ])('rejects an invalid reward name response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getRewardName()).rejects.toThrow(
      'The reward name response was invalid.',
    );
  });

  test('normalizes writes and validates the server response', async () => {
    mockPost.mockResolvedValue({ data: { rewardName: 'Points' } });

    await expect(updateRewardName('id-token', '  Points  ')).resolves.toEqual({
      rewardName: 'Points',
    });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/reward-name',
      { newRewardName: 'Points' },
      { headers: { Authorization: 'Bearer id-token' } },
    );
  });

  test('does not send an empty reward name', async () => {
    await expect(updateRewardName('id-token', '   ')).rejects.toThrow(
      'The reward name cannot be empty.',
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('does not send a reward name over the limit', async () => {
    expect(MAX_REWARD_NAME_LENGTH).toBe(32);
    await expect(
      updateRewardName('id-token', 'a'.repeat(MAX_REWARD_NAME_LENGTH + 1)),
    ).rejects.toThrow('The reward name must be at most 32 characters.');
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('counts code points, so an emoji is one character', async () => {
    const rewardName = `${'a'.repeat(MAX_REWARD_NAME_LENGTH - 1)}⚡`;
    mockPost.mockResolvedValue({ data: { rewardName } });

    await expect(updateRewardName('id-token', rewardName)).resolves.toEqual({
      rewardName,
    });
  });

  test.each(['sa\u0000ts', 'sa\nts', 'sa\tts', 'sa\u2028ts', '\nsats'])(
    'does not send a reward name with a control character: %j',
    async rewardName => {
      await expect(updateRewardName('id-token', rewardName)).rejects.toThrow(
        'The reward name must be one line of plain text, without control characters.',
      );
      expect(mockPost).not.toHaveBeenCalled();
    },
  );

  test('surfaces the backend reason for a refused save', async () => {
    mockPost.mockRejectedValue({
      response: {
        status: 400,
        data: { message: 'The reward name must be at most 32 characters.' },
      },
    });

    const attempt = updateRewardName('id-token', 'Points');
    await expect(attempt).rejects.toThrow(
      'The reward name must be at most 32 characters.',
    );
    await expect(attempt).rejects.toBeInstanceOf(RewardNameError);
  });

  test('passes other failures through unchanged', async () => {
    const outage = new Error('Network Error');
    mockPost.mockRejectedValue(outage);

    await expect(updateRewardName('id-token', 'Points')).rejects.toBe(outage);
  });
});

describe('reward amounts API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns validated reward amounts on read and write', async () => {
    const rewardAmounts = { pr_merged: 100, issue_closed: 50 };
    mockGet.mockResolvedValue({ data: { rewardAmounts } });
    mockPost.mockResolvedValue({ data: { message: 'ok', rewardAmounts } });

    await expect(getRewardAmounts('id-token')).resolves.toEqual({
      rewardAmounts,
    });
    await expect(
      updateRewardAmounts('id-token', rewardAmounts),
    ).resolves.toEqual({ rewardAmounts });
  });

  test.each([
    undefined,
    null,
    {},
    { rewardAmounts: null },
    { rewardAmounts: [100] },
    { rewardAmounts: { pr_merged: 'lots' } },
    { rewardAmounts: { pr_merged: Number.NaN } },
  ])('rejects an invalid reward amounts response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getRewardAmounts('id-token')).rejects.toThrow(
      'The reward amounts response was invalid.',
    );
  });
});

describe('automations API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the validated repository list on read and write', async () => {
    mockGet.mockResolvedValue({ data: { repos: ['owner/repo'] } });
    mockPost.mockResolvedValue({
      data: { message: 'ok', repos: ['owner/repo'] },
    });

    await expect(getAutomations('id-token')).resolves.toEqual({
      repos: ['owner/repo'],
    });
    await expect(
      updateAutomations('id-token', ['owner/repo']),
    ).resolves.toEqual({ repos: ['owner/repo'] });
  });

  test.each([
    undefined,
    null,
    {},
    { repos: 'owner/repo' },
    { repos: [''] },
    { repos: [42] },
  ])('rejects an invalid automations response: %p', async data => {
    mockGet.mockResolvedValue({ data });

    await expect(getAutomations('id-token')).rejects.toThrow(
      'The automations response was invalid.',
    );
  });
});

describe('reward policy API', () => {
  const OID = '11111111-2222-3333-4444-555555555555';
  const valid = {
    rewardAmounts: { githubPrMergedSats: 1000 },
    maxAmountSats: 10000,
    rewardPolicy: {
      version: 1,
      levels: {
        githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 250 } },
      },
      overrides: { [OID]: { githubPrMerged: { baseSats: 1500 } } },
      budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reads and writes a validated policy', async () => {
    mockGet.mockResolvedValue({ data: valid });
    mockPost.mockResolvedValue({ data: { message: 'ok', ...valid } });

    await expect(getRewardPolicy('id-token')).resolves.toEqual(valid);
    await expect(
      updateRewardPolicy('id-token', {
        budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
      }),
    ).resolves.toEqual(valid);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/reward-policy',
      {
        budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
      },
      { headers: { Authorization: 'Bearer id-token' } },
    );
  });

  test('accepts an unconfigured policy', () => {
    const empty = {
      rewardAmounts: {},
      maxAmountSats: 10000,
      rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
    };
    expect(parseRewardPolicyResponse(empty)).toEqual(empty);
  });

  const withPolicy = (change: Record<string, unknown>) => ({
    ...valid,
    rewardPolicy: { ...valid.rewardPolicy, ...change },
  });

  test.each([
    ['no body', undefined],
    ['a string amount', { ...valid, rewardAmounts: { a: '5' } }],
    ['a zero amount', { ...valid, rewardAmounts: { a: 0 } }],
    ['no cap', { ...valid, maxAmountSats: undefined }],
    [
      'a fractional bonus',
      withPolicy({
        levels: { githubPrMerged: { labelPrefix: 'r:', bonuses: { L1: 1.5 } } },
      }),
    ],
    [
      'a bad budget period',
      withPolicy({ budget: { period: 'day', capSats: 5, timezone: 'UTC' } }),
    ],
    [
      'a negative override',
      withPolicy({
        overrides: { [OID]: { githubPrMerged: { baseSats: -1 } } },
      }),
    ],
  ])('rejects %s', (_label, data) => {
    expect(() => parseRewardPolicyResponse(data)).toThrow(
      'The reward policy response was invalid.',
    );
  });

  test('reads the people list and refuses a malformed one', async () => {
    mockGet.mockResolvedValue({
      data: { people: [{ personAad: OID, displayName: 'Ada' }] },
    });

    await expect(getPeople('id-token')).resolves.toEqual([
      { personAad: OID, displayName: 'Ada' },
    ]);
    expect(() => parsePeopleResponse({ people: [{ personAad: 1 }] })).toThrow(
      'The people response was invalid.',
    );
  });
});
