import { UserFacingError } from '../messages';
import { parseSatsAmount } from '../utils/satsAmount';

// Card inputs arrive as strings and the amount regex (built from the live
// balance when the card is created) is client-only and forgeable, so the
// amount and the cumulative budget must be enforced server-side before any
// payment. The amount is parsed with the card's own digits rule
// (parseSatsAmount), never Number(): on a forged submit Number() reads
// '1.000' as 1 sat (an under-send) and '1e3' as 1,000 (an over-send).
// liveBalance must be a fresh read: the
// turn-state wallet snapshot never decrements across a multi-recipient loop.
//
// The errors carry message keys and raw numbers, not prose: the handler that
// catches them renders the text in the user's language and formats the
// numbers for the user's region (never the server's).

export const MAX_ZAP_SATS = 10000;

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
