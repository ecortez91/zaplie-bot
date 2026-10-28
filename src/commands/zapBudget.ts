import { UserFacingError } from '../messages';
import { positiveIntFromEnv } from '../services/envNumbers';
import { parseSatsAmount } from '../utils/satsAmount';

// Card inputs arrive as strings and the amount regex (built from the live
// balance when the card is created) is client-only and forgeable, so the
// amount and the cumulative budget must be enforced server-side before any
// payment. The amount is parsed with the card's own digits rule
// (parseSatsAmount), never Number(): on a forged submit Number() reads
// '1.000' as 1 sat (an under-send) and '1e3' as 1,000 (an over-send).
// liveBalance must be a fresh read: the
// turn-state wallet snapshot never decrements across a multi-recipient loop.
// The recipient count is capped too: Teams ends a card submit's turn after 15
// seconds, and every recipient is paid in sequence on that turn (four LNbits
// calls and two ledger writes each), so one card pays a bounded number of
// people (issue 444, docs/SOLUTION_DESIGN.adoc).
//
// The errors carry message keys and raw numbers, not prose: the handler that
// catches them renders the text in the user's language and formats the
// numbers for the user's region (never the server's).

export const MAX_ZAP_SATS = 10000;

export const ZAP_MAX_RECIPIENTS_ENV = 'ZAP_MAX_RECIPIENTS';
export const DEFAULT_ZAP_MAX_RECIPIENTS = 3;

// Read once per bot instance (constructor), so a malformed value refuses to
// start the bot, like ZAPLIE_LEDGER_STALE_LOCK_MS, instead of failing every
// submit with the generic error. 0 is refused too: it would make every zap
// impossible. The card reads the same resolver, so the limit it advertises is
// the one the submit enforces.
export const resolveZapMaxRecipients = (): number =>
  positiveIntFromEnv(ZAP_MAX_RECIPIENTS_ENV, DEFAULT_ZAP_MAX_RECIPIENTS);

export function validateRecipientCount(count: number, max: number): void {
  if (count > max) {
    throw new UserFacingError('tooManyRecipients', { max, count });
  }
}

export function validateZapSubmit(
  rawAmount: unknown,
  recipientCount: number,
  liveBalance: number,
  rewardName: string,
): number {
  const amount = parseSatsAmount(rawAmount, { max: MAX_ZAP_SATS });
  if (amount === null) {
    throw new UserFacingError('amountInvalid', {
      max: MAX_ZAP_SATS,
      rewardName,
    });
  }

  if (!Number.isInteger(recipientCount) || recipientCount < 1) {
    throw new UserFacingError('noRecipients');
  }

  // NaN passes `typeof x === 'number'` and every comparison against it is
  // false, so an unreadable balance would skip the budget check entirely.
  if (!Number.isFinite(liveBalance) || liveBalance < 0) {
    throw new UserFacingError('balanceUnreadable');
  }

  const totalRequired = amount * recipientCount;
  if (totalRequired > liveBalance) {
    throw new UserFacingError('budgetExceeded', {
      total: totalRequired,
      rewardName,
      count: recipientCount,
      balance: liveBalance,
    });
  }

  return amount;
}
