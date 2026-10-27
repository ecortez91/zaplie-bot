import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {
  createGithubWebhookRouter,
  GithubWebhookRouteDeps,
} from './githubWebhookRoute';
import { RewardLedger, rewardKey } from './services/rewardLedger';
import { RewardError } from './services/rewardsService';
import {
  createInvoice,
  getUserWalletsByUserId,
  payInvoice,
} from './services/lnbitsService';
import { resolveRewardRecipientByGithubId } from './services/identityService';
import { createPendingReward } from './services/pendingRewardsService';

// The real processReward and payReward run; only LNbits and the portal are
// stubbed, so "payInvoice was called once" means the treasury paid once.
jest.mock('./services/lnbitsService', () => ({
  getUserWalletsByUserId: jest.fn(),
  createInvoice: jest.fn(),
  payInvoice: jest.fn(),
}));
jest.mock('./services/identityService', () => ({
  resolveRewardRecipientByGithubId: jest.fn(),
}));
jest.mock('./services/pendingRewardsService', () => ({
  ...jest.requireActual<object>('./services/pendingRewardsService'),
  createPendingReward: jest.fn(),
}));

type AsyncMock = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const mockedPayInvoice = payInvoice as unknown as AsyncMock;
const mockedCreateInvoice = createInvoice as unknown as AsyncMock;
const mockedGetWallets = getUserWalletsByUserId as unknown as AsyncMock;
const mockedResolveRecipient =
  resolveRewardRecipientByGithubId as unknown as AsyncMock;
const mockedCreatePendingReward = createPendingReward as unknown as AsyncMock;

const SECRET = 'test-webhook-secret';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const mergedEvent = {
  action: 'closed',
  number: 7,
  pull_request: {
    id: 2001,
    number: 7,
    title: 'Add the thing',
    merged: true,
    merged_at: '2026-10-28T11:59:00Z',
    user: { login: 'octocat', id: 583231 },
  },
  repository: { full_name: 'octo-org/octo-repo' },
};
const PR_KEY = 'github:pull_request:2001:merged';

const tempDirectories: string[] = [];
const servers: http.Server[] = [];
let storePath: string;
let ledger: RewardLedger;
let deps: {
  assertRepoConnected: jest.Mock<(repo: string) => Promise<void>>;
  resolveAmountSats: jest.Mock<() => Promise<number>>;
  recordRewardOutcome: jest.Mock<(outcome: unknown) => void>;
};
let secret: string | undefined;
const savedTreasuryKey = process.env.REWARDS_TREASURY_ADMINKEY;

const startServer = async (
  overrides: Partial<GithubWebhookRouteDeps> = {},
): Promise<string> => {
  const app = express();
  // The real server mounts this route before express.json(); doing the same
  // here proves the raw body survives.
  app.use(
    createGithubWebhookRouter({
      ledger,
      webhookSecret: () => secret,
      now: () => NOW,
      ...(deps as unknown as Partial<GithubWebhookRouteDeps>),
      ...overrides,
    }),
  );
  app.use(express.json());
  const server = await new Promise<http.Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api/v1/github/webhook`;
};

const sign = (body: string, key = SECRET): string =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

interface DeliverOptions {
  event?: string;
  body?: unknown;
  rawBody?: string;
  signature?: string | null;
  delivery?: string;
  contentType?: string;
}

const deliver = async (
  url: string,
  {
    event = 'pull_request',
    body = mergedEvent,
    rawBody,
    signature,
    delivery = 'delivery-1',
    contentType = 'application/json',
  }: DeliverOptions = {},
) => {
  const payload = rawBody ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-event': event,
    'x-github-delivery': delivery,
  };
  const signed = signature === undefined ? sign(payload) : signature;
  if (signed !== null) {
    headers['x-hub-signature-256'] = signed;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
  });
  return {
    status: response.status,
    text: await response.text(),
    replayed: response.headers.get('idempotency-replayed'),
  };
};

beforeEach(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-webhook-'));
  tempDirectories.push(directory);
  storePath = path.join(directory, 'bot-reward-ledger.json');
  ledger = new RewardLedger({ storePath, lockRetryMs: 1 });
  secret = SECRET;
  deps = {
    assertRepoConnected: jest.fn(async () => undefined),
    resolveAmountSats: jest.fn(async () => 21),
    recordRewardOutcome: jest.fn(),
  };
  process.env.REWARDS_TREASURY_ADMINKEY = 'treasury-admin-key';
  mockedResolveRecipient.mockResolvedValue({
    personAad: 'oid-1',
    lnbitsUserId: 'user-1',
  });
  mockedGetWallets.mockResolvedValue([
    { id: 'wallet-private', name: 'Private', user: 'user-1', inkey: 'in' },
  ]);
  mockedCreateInvoice.mockResolvedValue('lnbc-invoice');
  mockedPayInvoice.mockResolvedValue({ payment_hash: 'hash-1' });
  mockedCreatePendingReward.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map(server => new Promise(resolve => server.close(resolve))),
  );
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (savedTreasuryKey === undefined) {
    delete process.env.REWARDS_TREASURY_ADMINKEY;
  } else {
    process.env.REWARDS_TREASURY_ADMINKEY = savedTreasuryKey;
  }
});

describe('POST /api/v1/github/webhook: authentication', () => {
  test('no secret configured is a 503 and touches nothing', async () => {
    secret = undefined;
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toEqual({
      error: 'GitHub webhook disabled: no secret configured',
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', null],
    ['signed with another secret', sign(JSON.stringify(mergedEvent), 'nope')],
    ['malformed', 'sha256=zz'],
  ])('a %s signature is a 401 and reserves nothing', async (_l, signature) => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();

    const response = await deliver(url, { signature });

    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: 'invalid signature' });
    expect(reserve).not.toHaveBeenCalled();
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a body altered after signing is a 401', async () => {
    const url = await startServer();
    const original = JSON.stringify(mergedEvent);
    const altered = JSON.stringify({
      ...mergedEvent,
      pull_request: {
        ...mergedEvent.pull_request,
        user: { login: 'mallory', id: 1 },
      },
    });

    const response = await deliver(url, {
      rawBody: altered,
      signature: sign(original),
    });

    expect(response.status).toBe(401);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a non-JSON content type is a 415', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      contentType: 'application/x-www-form-urlencoded',
    });

    expect(response.status).toBe(415);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a body over 1 MB is a 413 and reserves nothing', async () => {
    const reserve = jest.spyOn(ledger, 'reserve');
    const url = await startServer();
    const rawBody = JSON.stringify({
      ...mergedEvent,
      padding: 'x'.repeat(1024 * 1024 + 1),
    });

    const response = await deliver(url, { rawBody });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.text)).toEqual({ error: 'payload too large' });
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/github/webhook: events', () => {
  test('ping is a 204 and reserves nothing', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      event: 'ping',
      body: { zen: 'Keep it simple.' },
    });

    expect(response.status).toBe(204);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test.each([
    ['opened', { ...mergedEvent, action: 'opened' }],
    [
      'closed without merge',
      {
        ...mergedEvent,
        pull_request: { ...mergedEvent.pull_request, merged: false },
      },
    ],
  ])('a PR %s is a 204 and pays nothing', async (_label, body) => {
    const url = await startServer();

    const response = await deliver(url, { body });

    expect(response.status).toBe(204);
    expect(fs.existsSync(storePath)).toBe(false);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('a signed body that is not JSON is a 400', async () => {
    const url = await startServer();

    const response = await deliver(url, { rawBody: 'not json' });

    expect(response.status).toBe(400);
  });

  test('a merge older than the replay window is a 422 and pays nothing', async () => {
    const url = await startServer();

    const response = await deliver(url, {
      body: {
        ...mergedEvent,
        pull_request: {
          ...mergedEvent.pull_request,
          merged_at: '2026-01-01T00:00:00Z',
        },
      },
    });

    expect(response.status).toBe(422);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  test('a merged PR pays exactly once and records it as paid', async () => {
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({
      status: 'paid',
      paymentHash: 'hash-1',
      recipient: 'octocat',
      amountSats: 21,
    });
    expect(deps.assertRepoConnected).toHaveBeenCalledWith('octo-org/octo-repo');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
    expect(mockedResolveRecipient).toHaveBeenCalledWith('583231');
    await expect(
      new RewardLedger({ storePath }).get(rewardKey(PR_KEY)),
    ).resolves.toMatchObject({ state: 'paid' });
  });

  test('a redelivery of the same delivery replays and pays once', async () => {
    const url = await startServer();

    const first = await deliver(url);
    const second = await deliver(url);

    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(second.replayed).toBe('true');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a captured request resent under a new delivery id still replays', async () => {
    // X-GitHub-Delivery is not signed, so it cannot be the idempotency key.
    const url = await startServer();

    await deliver(url, { delivery: 'delivery-1' });
    const replayed = await deliver(url, { delivery: 'delivery-forged' });

    expect(replayed.status).toBe(200);
    expect(replayed.replayed).toBe('true');
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });

  test('a repo that is not connected is a 403 and the key is released', async () => {
    deps.assertRepoConnected.mockRejectedValueOnce(
      new RewardError("repo 'octo-org/octo-repo' is not connected", 403),
    );
    const url = await startServer();

    const rejected = await deliver(url);

    expect(rejected.status).toBe(403);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    await expect(ledger.get(rewardKey(PR_KEY))).resolves.toBeUndefined();
  });

  test('an unconfigured amount pays nothing and releases the key', async () => {
    deps.resolveAmountSats.mockRejectedValueOnce(
      new RewardError(
        "no configured amount for eventType 'githubPrMerged'",
        503,
      ),
    );
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(503);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
    await expect(ledger.get(rewardKey(PR_KEY))).resolves.toBeUndefined();
  });

  test('a merged PR by an unlinked author is queued as pending', async () => {
    mockedResolveRecipient.mockResolvedValue(null);
    const url = await startServer();

    const response = await deliver(url);

    expect(response.status).toBe(202);
    expect(mockedCreatePendingReward).toHaveBeenCalledTimes(1);
    expect(mockedPayInvoice).not.toHaveBeenCalled();
  });

  test('an uncertain payment is never retried by a redelivery', async () => {
    mockedPayInvoice.mockRejectedValueOnce(new Error('socket hang up'));
    const url = await startServer();

    const failed = await deliver(url);
    const redelivered = await deliver(url);

    expect(failed.status).toBe(500);
    expect(redelivered.status).toBe(409);
    expect(JSON.parse(redelivered.text)).toMatchObject({
      status: 'uncertain',
    });
    expect(mockedPayInvoice).toHaveBeenCalledTimes(1);
  });
});
