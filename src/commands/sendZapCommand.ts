import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory, MessageFactory } from 'botbuilder';
import {
  getUsers,
  payInvoice,
  createInvoice,
  getWalletBalance,
} from '../services/lnbitsService';
import { UserService } from '../services/userService';
import { genericErrorMessage } from '../messages';
import { Locale, resolveLocale, t } from '../i18n';
import {
  ZapPaymentExtra,
  toPaymentExtraWallet,
} from '../services/paymentExtra';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const lnbitsLabel = process.env.LNBITS_POINTS_LABEL as string;

export class SendZapCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    try {
      console.log("Running SendZapCommand's execute method.");

      const globalRewardName = lnbitsLabel;

      // Await the createZapCard function and log the result
      const currentUser = context.turnState.get('user');
      // Optional chaining: a language mismatch or a bare context must never
      // fail a turn, and the error path below runs for any failure.
      const locale = resolveLocale(context.activity?.locale);
      const card = await createZapCard(currentUser, globalRewardName, locale);
      console.log('createZapCard:', card); // Log the card content

      // Create the message with the adaptive card
      const message = MessageFactory.attachment(CardFactory.adaptiveCard(card));
      console.log('Message Content:', message); // Log the message content

      // Send the adaptive card message
      await context.sendActivity(message);
      console.log('sendActivity completed.');
    } catch (error) {
      // The details belong in the logs: an LNbits error message can carry
      // wallet ids or configuration names into the chat.
      console.error('SendZapCommand failed:', error);
      await context.sendActivity(
        genericErrorMessage(resolveLocale(context.activity?.locale)),
      );
    }
  }
}

export interface SendZapResult {
  paymentHash: string;
}

export interface ZapReceipt {
  recipients: string[];
  failedRecipients?: string[];
  // Recipients whose payment was sent but never confirmed. They are NOT
  // failures: the money may already have moved, so they get their own section
  // instead of an invitation to retry.
  uncertainRecipients?: string[];
  message: string;
  amount: number;
  remainingBalance: number;
  rewardName: string;
}

// One key/value row of the receipt: bold label on the left, value on the
// right. Kept flat — a ColumnSet must only ever contain Columns.
const receiptRow = (label: string, value: string) => ({
  type: 'ColumnSet',
  columns: [
    {
      type: 'Column',
      width: 'auto',
      items: [
        {
          type: 'TextBlock',
          text: label,
          weight: 'Bolder',
        },
      ],
    },
    {
      type: 'Column',
      width: 'stretch',
      items: [
        {
          type: 'TextBlock',
          text: value,
          wrap: true,
        },
      ],
    },
  ],
});

// The read-only receipt a zap card turns into once a submit finishes. It
// reports the recipients this submit processed — recipients already settled by
// an earlier submit of the same card are not repeated here.
export function buildZapReceiptCard(
  receipt: ZapReceipt,
  locale: Locale = 'en',
) {
  const {
    recipients,
    failedRecipients = [],
    uncertainRecipients = [],
    message,
    amount,
    remainingBalance,
    rewardName,
  } = receipt;

  const receiverLabel =
    recipients.length > 1
      ? t(locale, 'receiptReceivers')
      : t(locale, 'receiptReceiver');
  const totalAmountSent = recipients.length * amount;
  const bulletList = (names: string[]): string =>
    names.map(name => `- ${name}`).join('\n');

  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'TextBlock',
        text: t(locale, 'receiptTitle'),
        weight: 'Bolder',
        size: 'Large',
        color: 'Good',
      },
      receiptRow(receiverLabel, recipients.join(', ')),
      ...(failedRecipients.length > 0
        ? [
            {
              type: 'TextBlock',
              text: t(locale, 'receiptFailed', {
                list: bulletList(failedRecipients),
              }),
              wrap: true,
              color: 'Attention',
            },
          ]
        : []),
      // Kept apart from the failures on purpose: these payments were sent and
      // may well have settled, so listing them as failed would invite a retry
      // that pays the same person twice.
      ...(uncertainRecipients.length > 0
        ? [
            {
              type: 'TextBlock',
              text: t(locale, 'receiptNeedsChecking', {
                list: bulletList(uncertainRecipients),
              }),
              wrap: true,
              color: 'Warning',
            },
          ]
        : []),
      receiptRow(t(locale, 'receiptMessage'), message),
      receiptRow(
        t(locale, 'receiptAmount', { rewardName }),
        amount.toLocaleString(),
      ),
      ...(recipients.length > 1
        ? [
            receiptRow(
              t(locale, 'receiptTotal', { rewardName }),
              totalAmountSent.toLocaleString(),
            ),
          ]
        : []),
      receiptRow(
        t(locale, 'receiptRemaining', { rewardName }),
        remainingBalance.toLocaleString(),
      ),
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
  };
}

// Thrown only once payInvoice has been called: at that point the payment may
// have settled even though we failed to confirm it, so a retry is unsafe.
export class PaymentOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentOutcomeUnknownError';
  }
}

export async function SendZap(
  sender: User,
  receiver: User,
  zapMessage: string,
  zapAmount: number,
  context: TurnContext,
  updateCard: boolean = true,
  globalRewardName: string,
): Promise<SendZapResult> {
  try {
    console.log('Sending zap ...');

    // Metadata LNbits stores on the invoice and the payment so the portal
    // can show who zapped whom. Wallet objects carry keys, so only the
    // projection goes in, and a missing wallet fails before any LNbits call.
    const extra: ZapPaymentExtra = {
      tag: 'zap',
      from: toPaymentExtraWallet(
        sender.allowanceWallet,
        'sender Allowance',
        sender.displayName,
      ),
      to: toPaymentExtraWallet(
        receiver.privateWallet,
        'receiver Private',
        receiver.displayName,
      ),
    };

    // Create an invoice for the amount in the recipient's wallet
    const paymentRequest = await createInvoice(
      receiver.privateWallet.inkey,
      receiver.privateWallet.id,
      zapAmount,
      zapMessage,
      extra,
    );

    if (!paymentRequest) {
      throw new Error('Failed to create an invoice.');
    }

    // Pay the invoice

    let result;
    try {
      result = await payInvoice(
        sender.allowanceWallet.adminkey,
        paymentRequest,
        extra,
      );
    } catch (error) {
      throw new PaymentOutcomeUnknownError(
        'The payment request failed after being sent to LNbits.',
        error,
      );
    }

    if (!result?.payment_hash) {
      throw new PaymentOutcomeUnknownError(
        'The payment returned no payment hash, so it cannot be confirmed.',
      );
    }
    const paymentHash: string = result.payment_hash;

    console.log('Payment result: settled');

    // Past this point the payment has settled and its hash is in hand, so
    // nothing that follows may reach the caller as a plain Error: that is the
    // signal for "never left this process", and it would release the ledger
    // entry and let a resubmit pay the same recipient again. Everything below
    // is presentation - a balance read and a card update - so a failure is
    // logged and the confirmed hash is still returned.
    const updateReceiptCard = async (): Promise<void> => {
      // Updated adaptive card (read-only)
      //fetch remainingBalance
      const remainingBalance = await getWalletBalance(
        sender.allowanceWallet.inkey,
      );
      console.log('Remaining Balance:', remainingBalance);

      const updatedCard = buildZapReceiptCard(
        {
          recipients: [receiver.displayName],
          message: zapMessage,
          amount: zapAmount,
          remainingBalance,
          rewardName: globalRewardName,
        },
        resolveLocale(context.activity?.locale),
      );

      // Update responsive card in message
      const updatedMessage = MessageFactory.attachment(
        CardFactory.adaptiveCard(updatedCard),
      );

      updatedMessage.id = context.activity.replyToId; // The ID of the current message is used.
      await context.updateActivity(updatedMessage);

      console.log('Adaptive card updated to read-only.');
    };

    if (updateCard) {
      try {
        await updateReceiptCard();
      } catch (error) {
        console.error(
          'The zap settled but its receipt card could not be updated; the ' +
            'payment stands and the ledger keeps it recorded as paid.',
          error,
        );
      }
    }

    return { paymentHash };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(String(error), { cause: error });
  }
}

// Function to create an adaptive card
async function createZapCard(
  sender: User,
  globalRewardName: string,
  locale: Locale,
) {
  console.log('Creating Zap Card ...');
  const walletChoices = await populateWalletChoices();

  // TODO: Add the users current balance to here!
  const currentBalance = await getWalletBalance(sender.allowanceWallet.inkey);

  const cardBody = [
    {
      type: 'Input.ChoiceSet',
      label: t(locale, 'cardReceiverLabel'),
      id: 'zapReceiverId',
      placeholder: t(locale, 'cardReceiverPlaceholder'),
      choices: walletChoices,
      isRequired: true,
      isMultiSelect: true,
      errorMessage: t(locale, 'cardReceiverError'),
    },
    {
      type: 'Input.Text',
      label: t(locale, 'cardMessageLabel'),
      size: 'medium',
      id: 'zapMessage',
      isRequired: true,
      placeholder: t(locale, 'cardMessagePlaceholder'),
      errorMessage: t(locale, 'cardMessageError'),
    },
    {
      type: 'Input.Text',
      id: 'zapAmount',
      placeholder: '100',
      label: t(locale, 'cardAmountLabel', { rewardName: globalRewardName }),
      regex: '^(?:10000|[1-9][0-9]{0,3})$',
      isRequired: true,
      errorMessage: t(locale, 'cardAmountError', { rewardName: lnbitsLabel }),
    },
    {
      type: 'TextBlock',
      text: t(locale, 'cardBalance', {
        rewardName: globalRewardName,
        balance: currentBalance,
      }),
      wrap: true,
      color: 'Good',
    },
  ];

  /*
  // Add people picker input if globalMentionedUserName is null or undefined
  if (!globalMentionedUserName) {
    cardBody.unshift({
      type: 'Input.ChoiceSet',
      id: 'recipient',
      placeholder: 'Select a person to send zaps to',
      choices: [], // Initialize choices as an empty array
      choicesData: { // Use choicesData instead of data
        type: "Data.Query",
        dataset: "graph.microsoft.com/users"
      }
    });
  }*/

  return {
    type: 'AdaptiveCard',
    body: cardBody,
    actions: [
      {
        type: 'Action.Submit',
        title: t(locale, 'cardSendButton'),
        data: {
          action: 'submitZaps',
        },
      },
    ],
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.5',
  };
}

// Function to populate choices
async function populateWalletChoices() {
  console.log('Populating wallet choices ...');
  const users = await getUsers(adminKey, null);

  // Get the current user
  const userService = UserService.getInstance();
  const currentUser = userService.getCurrentUser();

  let filteresUsers = users;
  if (currentUser) {
    filteresUsers = users.filter(
      user => user?.aadObjectId !== userService.getCurrentUser().aadObjectId,
    );
  }

  if (filteresUsers) {
    return filteresUsers.map(user => ({
      title: user.displayName,
      value: user.id,
    }));
  }
  return [];
}
