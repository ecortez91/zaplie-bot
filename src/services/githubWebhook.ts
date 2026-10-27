import { createHmac, timingSafeEqual } from 'crypto';

const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;
// The invoice memo carries the reason; a PR title can be long, so cap it.
const MAX_TITLE_LENGTH = 120;

/**
 * True when `X-Hub-Signature-256` is the HMAC-SHA256 of the exact raw body
 * under the shared webhook secret. Compared in constant time.
 *
 * @param rawBody the request body bytes as received, before any JSON parse
 * @param header the `X-Hub-Signature-256` value (`sha256=<hex>`)
 * @param secret the webhook secret; an empty secret never verifies
 */
export const verifyGithubSignature = (
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean => {
  if (!secret || typeof header !== 'string') {
    return false;
  }
  const presented = header.trim().toLowerCase();
  if (!SIGNATURE_PATTERN.test(presented)) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(
    Buffer.from(presented.slice(SIGNATURE_PREFIX.length), 'hex'),
    Buffer.from(expected, 'hex'),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Control characters and line breaks never belong in an invoice memo.
const cleanTitle = (title: unknown): string => {
  if (typeof title !== 'string') {
    return '';
  }
  const flat = Array.from(title)
    .map(character => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(flat);
  return characters.length > MAX_TITLE_LENGTH
    ? `${characters.slice(0, MAX_TITLE_LENGTH - 1).join('')}…`
    : flat;
};

const MAX_LABELS = 50;
const LABEL_PATTERN = /^[ -~]{1,50}$/;

// Label names as they stood at merge. A name the reward request would refuse
// (non-ASCII, too long) cannot match a configured level anyway, so it is
// dropped here rather than failing the whole reward.
const labelNames = (labels: unknown): string[] => {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map(label => (isRecord(label) ? label.name : undefined))
    .filter(
      (name): name is string =>
        typeof name === 'string' && LABEL_PATTERN.test(name),
    )
    .slice(0, MAX_LABELS);
};

export type GithubPullRequestReward =
  | { kind: 'ignored' }
  | { kind: 'invalid'; error: string }
  | { kind: 'too-old' }
  | { kind: 'not-rewarded'; reason: string }
  | { kind: 'reward'; idempotencyKey: string; body: Record<string, unknown> };

// A signature has no timestamp, so a captured delivery stays valid forever.
// The idempotency key comes from the signed body (below), and the reward
// ledger keeps settled records for 90 days; a merge older than this is
// refused so a replay can never outlive its ledger record.
export const MAX_MERGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Turns a verified `pull_request` event into a reward, in the same body shape
 * `POST /api/v1/rewards` accepts. Only a merge earns anything. The body is
 * parsed again by `parseRewardRequest`, so a malformed event still fails
 * validation there.
 *
 * The idempotency key is the pull request's own id, not `X-GitHub-Delivery`:
 * the delivery header is not covered by the signature, so a captured request
 * resent under a new delivery id must still replay, not pay again. A pull
 * request merges once, so one key per pull request is exactly one reward.
 *
 * Only identity and location come from GitHub; the amount never does.
 *
 * Two merges earn nothing: a bot's (Dependabot and friends have no Zaplie
 * person, so they would only queue pending rewards), and one the author
 * merged themselves (anyone with write access could otherwise pay themselves
 * a reward per trivial pull request). Auto-merge counts as the person who
 * enabled it, so an author enabling it on their own pull request is refused.
 * A merge queue merges as `github-merge-queue[bot]`, so who queued it is not
 * in this event: there the guard cannot apply, and required reviews in
 * branch protection must stand in for it.
 */
export const githubPullRequestReward = (
  event: unknown,
  now: number = Date.now(),
): GithubPullRequestReward => {
  if (!isRecord(event) || event.action !== 'closed') {
    return { kind: 'ignored' };
  }
  const pullRequest = event.pull_request;
  if (!isRecord(pullRequest) || pullRequest.merged !== true) {
    return { kind: 'ignored' };
  }
  const pullRequestId = pullRequest.id;
  if (
    typeof pullRequestId !== 'number' ||
    !Number.isSafeInteger(pullRequestId) ||
    pullRequestId <= 0
  ) {
    return { kind: 'invalid', error: 'pull_request.id is missing' };
  }
  const mergedAt =
    typeof pullRequest.merged_at === 'string'
      ? Date.parse(pullRequest.merged_at)
      : NaN;
  if (Number.isNaN(mergedAt)) {
    return { kind: 'invalid', error: 'pull_request.merged_at is missing' };
  }
  if (now - mergedAt > MAX_MERGE_AGE_MS) {
    return { kind: 'too-old' };
  }
  const user = isRecord(pullRequest.user) ? pullRequest.user : {};
  if (
    user.type === 'Bot' ||
    (typeof user.login === 'string' && user.login.endsWith('[bot]'))
  ) {
    return { kind: 'not-rewarded', reason: 'author is a bot' };
  }
  // Checked here, not only by parseRewardRequest, so the self-merge
  // comparison below is always number against number.
  if (
    typeof user.id !== 'number' ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    return { kind: 'invalid', error: 'pull_request.user.id is missing' };
  }
  // GitHub sets merged_by on every merged pull request; without it nobody
  // can tell a self-merge apart, so the merge is refused.
  const mergedBy = isRecord(pullRequest.merged_by)
    ? pullRequest.merged_by
    : undefined;
  if (
    !mergedBy ||
    typeof mergedBy.id !== 'number' ||
    !Number.isSafeInteger(mergedBy.id)
  ) {
    return { kind: 'invalid', error: 'pull_request.merged_by is missing' };
  }
  if (mergedBy.id === user.id) {
    return {
      kind: 'not-rewarded',
      reason: 'author merged their own pull request',
    };
  }
  const repository = isRecord(event.repository) ? event.repository : {};
  const title = cleanTitle(pullRequest.title);
  const number = pullRequest.number;
  return {
    kind: 'reward',
    idempotencyKey: `github:pull_request:${pullRequestId}:merged`,
    body: {
      recipient: user.login,
      recipientId: user.id,
      eventType: 'githubPrMerged',
      repo: repository.full_name,
      reason: `GitHub: PR #${typeof number === 'number' ? number : '?'} merged${
        title ? ` - ${title}` : ''
      }`,
      source: 'github',
      labels: labelNames(pullRequest.labels),
    },
  };
};
