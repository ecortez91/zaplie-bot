import { createHmac } from 'crypto';
import { describe, expect, test } from '@jest/globals';
import {
  githubPullRequestReward,
  MAX_MERGE_AGE_MS,
  verifyGithubSignature,
} from './githubWebhook';

const SECRET = 'test-webhook-secret';
const sign = (body: Buffer, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyGithubSignature', () => {
  const body = Buffer.from('{"action":"closed"}');

  test('accepts the HMAC of the exact body', () => {
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe(true);
  });

  test('accepts an upper-case hex digest', () => {
    expect(verifyGithubSignature(body, sign(body).toUpperCase(), SECRET)).toBe(
      true,
    );
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['without the sha256= prefix', sign(body).slice(7)],
    ['sha1', `sha1=${'a'.repeat(40)}`],
    ['too short', 'sha256=abc'],
    ['under another secret', sign(body, 'other-secret')],
  ])('rejects a signature that is %s', (_label, header) => {
    expect(verifyGithubSignature(body, header, SECRET)).toBe(false);
  });

  test('rejects a body changed by one byte', () => {
    const tampered = Buffer.from('{"action":"closee"}');
    expect(verifyGithubSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  test('an empty secret never verifies, even a matching empty-key HMAC', () => {
    expect(verifyGithubSignature(body, sign(body, ''), '')).toBe(false);
  });
});

describe('githubPullRequestReward', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const merged = (overrides: Record<string, unknown> = {}) => ({
    action: 'closed',
    pull_request: {
      id: 2001,
      number: 7,
      title: 'Add the thing',
      merged: true,
      merged_at: '2026-10-28T11:59:00Z',
      user: { login: 'octocat', id: 583231 },
      ...overrides,
    },
    repository: { full_name: 'octo-org/octo-repo' },
  });

  test('a merged PR becomes a githubPrMerged reward keyed by the PR id', () => {
    expect(githubPullRequestReward(merged(), now)).toEqual({
      kind: 'reward',
      idempotencyKey: 'github:pull_request:2001:merged',
      body: {
        recipient: 'octocat',
        recipientId: 583231,
        eventType: 'githubPrMerged',
        repo: 'octo-org/octo-repo',
        reason: 'GitHub: PR #7 merged - Add the thing',
        source: 'github',
        labels: [],
      },
    });
  });

  test('label names are carried, and names no request would accept are dropped', () => {
    const reward = githubPullRequestReward(
      merged({
        labels: [
          { name: 'reward:L2' },
          { name: 'bug' },
          { name: 'récompense' },
          { name: 'x'.repeat(51) },
          { id: 3 },
          'not-an-object',
        ],
      }),
      now,
    );
    expect(reward.kind === 'reward' && reward.body.labels).toEqual([
      'reward:L2',
      'bug',
    ]);
  });

  test('the body never carries an amount', () => {
    const reward = githubPullRequestReward(merged(), now);
    expect(reward.kind === 'reward' && 'amountSats' in reward.body).toBe(false);
  });

  test.each([
    ['opened', { action: 'opened' }],
    ['closed without merge', { pull_request: { merged: false } }],
    ['not an object', null],
  ])('%s is ignored', (_label, change) => {
    const event =
      change === null ? null : { ...merged(), ...(change as object) };
    expect(githubPullRequestReward(event, now)).toEqual({ kind: 'ignored' });
  });

  test('a merge without a pull request id is invalid', () => {
    expect(githubPullRequestReward(merged({ id: undefined }), now)).toEqual({
      kind: 'invalid',
      error: 'pull_request.id is missing',
    });
  });

  test('a merge without merged_at is invalid', () => {
    expect(
      githubPullRequestReward(merged({ merged_at: null }), now),
    ).toMatchObject({ kind: 'invalid' });
  });

  test('a merge older than the replay window is refused', () => {
    const old = new Date(now - MAX_MERGE_AGE_MS - 1000).toISOString();
    expect(githubPullRequestReward(merged({ merged_at: old }), now)).toEqual({
      kind: 'too-old',
    });
  });

  test('control characters in the title are flattened and long titles cut', () => {
    const reward = githubPullRequestReward(
      merged({ title: `Line one\nline\u0007two ${'x'.repeat(300)}` }),
      now,
    );
    expect(reward.kind).toBe('reward');
    const reason = reward.kind === 'reward' ? String(reward.body.reason) : '';
    expect(reason).toMatch(/^GitHub: PR #7 merged - Line one line two x+…$/);
    expect(Array.from(reason).length).toBeLessThanOrEqual(
      'GitHub: PR #7 merged - '.length + 120,
    );
  });
});
