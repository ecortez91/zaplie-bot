// Tells a zap recipient, in their personal chat with the bot, that a zap to
// them has settled. The chat is opened on demand through the adapter's
// createConversationAsync, addressing the person by AAD object id with the
// tenant, service URL and bot identity of the sender's own turn: Teams
// returns the existing chat when there is one, so nothing is stored between
// turns and no Graph permission is involved. Runs after the ledger has
// recorded the payment and after the sender's receipt, and is best effort by
// contract: it returns an outcome and never throws, so nothing here can fail
// the sender's turn.

import { MessageFactory, TextFormatTypes } from 'botbuilder';
import type {
  ChannelAccount,
  ConversationParameters,
  TurnContext,
} from 'botbuilder';
import config from '../config';
import { zapReceivedMessage } from '../messages';

export interface ZapNotification {
  recipient: { aadObjectId?: string; displayName?: string };
  senderName: string;
  amount: number;
  rewardName: string;
  message: string;
}

// 'unreachable': Teams would not open the chat for that person (the app is
// not installed for them, or the id is unknown to the tenant): expected, one
// warning. 'failed': anything else, from missing configuration to a 401, a
// 5xx or a send refused once the chat was open: an error for the operator.
export type NotificationOutcome = 'notified' | 'unreachable' | 'failed';

// The OAuth scope for outbound calls to the Bot Framework channel service:
// AuthenticationConstants.ToChannelFromBotOAuthScope in botframework-connector,
// which is not a direct dependency of this package. Replies use the same one.
const BOT_FRAMEWORK_AUDIENCE = 'https://api.botframework.com';

// What Teams answers when the person cannot be addressed: 400 with
// MemberNotFoundInConversation (unknown id) or BadSyntax (id that is not a
// user in the tenant), both observed in the trial tenant, and 403/404 for an
// app that is not installed for them. Everything else is not about the
// recipient.
const UNREACHABLE_STATUS_CODES: ReadonlySet<number> = new Set([400, 403, 404]);

interface ConnectorError {
  statusCode?: number;
  code?: string;
  message?: string;
}

const connectorError = (error: unknown): ConnectorError =>
  typeof error === 'object' && error !== null
    ? (error as ConnectorError)
    : { message: String(error) };

const isUnreachable = (error: unknown): boolean => {
  const { statusCode } = connectorError(error);
  return (
    typeof statusCode === 'number' && UNREACHABLE_STATUS_CODES.has(statusCode)
  );
};

export interface RecipientNotifierDeps {
  botAppId?: string;
}

export const notifyZapRecipient = async (
  context: TurnContext,
  notification: ZapNotification,
  deps: RecipientNotifierDeps = {},
): Promise<NotificationOutcome> => {
  const { recipient } = notification;
  const who = recipient.aadObjectId ?? recipient.displayName ?? '(unknown)';
  let stage: 'prepare' | 'open' | 'send' = 'prepare';
  try {
    if (!recipient.aadObjectId) {
      console.warn(
        `Zap recipient ${who} has no AAD object id on their LNbits account, so no notification was sent.`,
      );
      return 'unreachable';
    }
    const botAppId = deps.botAppId ?? config.botId;
    if (!botAppId) {
      throw new Error('BOT_ID is not set, so the bot cannot open a chat.');
    }
    const { activity } = context;
    // Teams stamps the tenant on the conversation for most activities and
    // only in channelData for some; read both rather than guess.
    const channelData = activity.channelData as
      { tenant?: { id?: string } } | undefined;
    const tenantId = activity.conversation?.tenantId ?? channelData?.tenant?.id;
    if (
      !tenantId ||
      !activity.serviceUrl ||
      !activity.channelId ||
      !activity.recipient?.id
    ) {
      throw new Error(
        'The turn carries no tenant, service URL, channel or bot identity to open a chat with.',
      );
    }
    const parameters: ConversationParameters = {
      isGroup: false,
      bot: activity.recipient,
      // Teams addresses the member by id alone; the schema type also lists a
      // display name, which is not sent.
      members: [{ id: recipient.aadObjectId } as ChannelAccount],
      tenantId,
      channelData: { tenant: { id: tenantId } },
    };
    // Plain text: the zap message is the sender's own words, and markdown in
    // it must not restyle the line.
    const line = MessageFactory.text(zapReceivedMessage(notification));
    line.textFormat = TextFormatTypes.Plain;

    let ran = false;
    let delivery: unknown;
    stage = 'open';
    await context.adapter.createConversationAsync(
      botAppId,
      activity.channelId,
      activity.serviceUrl,
      BOT_FRAMEWORK_AUDIENCE,
      parameters,
      async proactive => {
        ran = true;
        stage = 'send';
        // Caught here on purpose: an error that leaves this callback goes to
        // the adapter's onTurnError, which would send the generic apology to
        // the recipient and let the send report as fine.
        try {
          await proactive.sendActivity(line);
        } catch (error) {
          delivery = error;
        }
      },
    );
    if (!ran) {
      // The pipeline resolved without reaching the callback: a middleware
      // threw first and onTurnError swallowed it. Not a delivery.
      stage = 'send';
      throw new Error(
        'The bot pipeline never reached the send: a middleware failed before the callback.',
      );
    }
    if (delivery !== undefined) {
      throw delivery;
    }
    return 'notified';
  } catch (error) {
    if (stage === 'open' && isUnreachable(error)) {
      const { statusCode, code, message } = connectorError(error);
      console.warn(
        `Zap recipient ${who} cannot be addressed in Teams (is the app installed for them?), so no notification was sent; the zap is in their wallet. ${statusCode} ${code ?? ''}: ${message ?? ''}`,
      );
      return 'unreachable';
    }
    const { statusCode } = connectorError(error);
    console.error(
      `Zap recipient ${who} could not be notified (${stage}${statusCode ? `, ${statusCode}` : ''}); the payment stands.`,
      error,
    );
    return 'failed';
  }
};
