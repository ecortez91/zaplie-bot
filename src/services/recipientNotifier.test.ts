// The notifier runs after the payment: every path below must resolve to an
// outcome, and only the happy path may count as a delivery. The stand-in
// adapter mimics the real pipeline: it runs the callback and, like
// runMiddleware, routes an error that escapes it (or one thrown by a
// middleware before it) to onTurnError instead of rejecting, which is exactly
// the case the notifier must not mistake for a delivery.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type { Activity, TurnContext } from 'botbuilder';
import { notifyZapRecipient } from './recipientNotifier';

jest.mock('../config', () => ({ __esModule: true, default: {} }));

const notification = {
  recipient: { aadObjectId: 'aad-bob', displayName: 'Bob' },
  senderName: 'Alice',
  amount: 21,
  rewardName: 'Sats',
  message: 'Thanks for the review!',
};

// The shape botframework-connector rejects with.
const restError = (statusCode: number, code: string, message: string) =>
  Object.assign(new Error(message), { name: 'RestError', statusCode, code });

let sent: Partial<Activity>[];
const sendActivity = jest.fn(async (activity: Partial<Activity>) => {
  sent.push(activity);
  return undefined;
});
const proactive = { sendActivity } as unknown as TurnContext;
const onTurnError = jest.fn(
  async (_context: TurnContext, _error: unknown) => undefined,
);
// A middleware that throws before the callback, when set.
let middlewareFailure: Error | undefined;

const createConversationAsync = jest.fn(
  async (
    _botAppId: string,
    _channelId: string,
    _serviceUrl: string,
    _audience: string,
    _parameters: unknown,
    logic: (context: TurnContext) => Promise<void>,
  ) => {
    try {
      if (middlewareFailure) {
        throw middlewareFailure;
      }
      await logic(proactive);
    } catch (error) {
      await onTurnError(proactive, error);
    }
  },
);

const makeContext = (activity: Partial<Activity> = {}): TurnContext =>
  ({
    activity: {
      type: 'message',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/amer/tenant-1/',
      recipient: { id: '28:bot', name: 'Zaplie' },
      from: { id: '29:alice', aadObjectId: 'aad-alice', name: 'Alice' },
      conversation: {
        id: 'a:conv-alice',
        conversationType: 'personal',
        tenantId: 'tenant-1',
      },
      ...activity,
    },
    adapter: { createConversationAsync },
  }) as unknown as TurnContext;

const deps = { botAppId: 'bot-app-id' };

beforeEach(() => {
  sent = [];
  middlewareFailure = undefined;
  sendActivity.mockClear();
  createConversationAsync.mockClear();
  onTurnError.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('notifyZapRecipient', () => {
  test('opens the recipient chat by AAD object id and sends one plain-text line', async () => {
    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('notified');
    expect(createConversationAsync).toHaveBeenCalledWith(
      'bot-app-id',
      'msteams',
      'https://smba.trafficmanager.net/amer/tenant-1/',
      'https://api.botframework.com',
      {
        isGroup: false,
        bot: { id: '28:bot', name: 'Zaplie' },
        members: [{ id: 'aad-bob' }],
        tenantId: 'tenant-1',
        channelData: { tenant: { id: 'tenant-1' } },
      },
      expect.any(Function),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(
      '⚡ Alice zapped you 21 Sats: "Thanks for the review!"',
    );
    expect(sent[0].textFormat).toBe('plain');
  });

  test('reads the tenant from channelData when the conversation carries none', async () => {
    const context = makeContext({
      conversation: {
        id: 'a:conv-alice',
        conversationType: 'personal',
      } as Activity['conversation'],
      channelData: { tenant: { id: 'tenant-2' } },
    });

    await expect(notifyZapRecipient(context, notification, deps)).resolves.toBe(
      'notified',
    );
    expect(createConversationAsync.mock.calls[0][4]).toMatchObject({
      tenantId: 'tenant-2',
    });
  });

  test('a recipient without an AAD object id is unreachable and nothing is opened', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(
      makeContext(),
      { ...notification, recipient: { displayName: 'Bob' } },
      deps,
    );

    expect(outcome).toBe('unreachable');
    expect(createConversationAsync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bob'));
  });

  test.each([
    [400, 'MemberNotFoundInConversation', 'Member not found in conversation.'],
    [400, 'BadSyntax', 'Invalid user identity in provided tenant'],
    [
      403,
      'BotNotInConversationRoster',
      'The bot is not part of the conversation roster.',
    ],
  ])(
    'a person Teams cannot address (%i %s) is unreachable, logged as one warning, and nothing is sent',
    async (statusCode, code, message) => {
      createConversationAsync.mockRejectedValueOnce(
        restError(statusCode, code, message),
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await notifyZapRecipient(
        makeContext(),
        notification,
        deps,
      );

      expect(outcome).toBe('unreachable');
      expect(sent).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`aad-bob.*${statusCode} ${code}: ${message}`),
        ),
      );
      expect(error).not.toHaveBeenCalled();
    },
  );

  test('a Teams refusal that is not about the recipient (401) is a failure, logged as an error', async () => {
    createConversationAsync.mockRejectedValueOnce(
      restError(
        401,
        'Unauthorized',
        'Authorization has been denied for this request.',
      ),
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/aad-bob.*open, 401/),
      expect.any(Error),
    );
  });

  test('a send refused after the chat opened is a failure and never reaches onTurnError', async () => {
    sendActivity.mockRejectedValueOnce(
      restError(403, 'Forbidden', 'Forbidden'),
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(onTurnError).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/aad-bob.*send, 403/),
      expect.any(Error),
    );
  });

  test('a middleware failure before the callback is a failure, not a delivery', async () => {
    middlewareFailure = new TypeError(
      "Cannot read properties of undefined (reading 'id')",
    );
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await notifyZapRecipient(makeContext(), notification, deps);

    expect(outcome).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('aad-bob'),
      expect.objectContaining({
        message: expect.stringContaining('never reached the send'),
      }),
    );
  });

  test('a turn without a service URL or tenant is a failure, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyZapRecipient(
        makeContext({ serviceUrl: undefined }),
        notification,
        deps,
      ),
    ).resolves.toBe('failed');
    await expect(
      notifyZapRecipient(
        makeContext({
          conversation: { id: 'a:conv-alice' } as Activity['conversation'],
        }),
        notification,
        deps,
      ),
    ).resolves.toBe('failed');
    expect(createConversationAsync).not.toHaveBeenCalled();
  });

  test('a missing bot app id is a failure, not a crash', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      notifyZapRecipient(makeContext(), notification, { botAppId: '' }),
    ).resolves.toBe('failed');
    expect(createConversationAsync).not.toHaveBeenCalled();
  });
});
