// satsAmount.ts
//
// The server-side parser for a user-typed sats amount. It applies the zap
// card's digit grammar (ASCII digits, no sign, no leading zero), so a submit
// forged outside the card cannot pass a form the card would refuse. The cap is
// the caller's: validateZapSubmit checks MAX_ZAP_SATS and the live balance at
// submit, not the balance the card was rendered with. Number() is not that
// rule: it reads '1e3' as 1,000, '1.000' as 1, '0x10' as 16, and trims ' 5 ' to 5.
//
// The same rule lives in two other places, so read all three together:
// - zapAmountRegex in src/commands/sendZapCommand.ts is the card's client-side
//   twin (the parity test in sendZapCommand.test.ts proves they agree);
// - parseAmount in tabs/backend/lnbitsRoutes.js is the portal gateway's
//   version, which takes a JSON number and never parses a string.

export interface SatsAmountBounds {
  /** Inclusive lower bound; defaults to 1. */
  min?: number;
  /** Inclusive upper bound. */
  max: number;
}

/**
 * The rule as a pattern: ASCII digits only, no sign, no whitespace, no
 * leading zero. Exported so a test can prove it matches what the card allows.
 */
export const SATS_AMOUNT_PATTERN = /^[1-9][0-9]*$/;

/**
 * Parses a user-typed sats amount with the card's own rule: a string of ASCII
 * digits with no leading zero, a safe integer within [min, max]. Anything else,
 * including a value that is not a string, is null. Never throws: the caller
 * owns the user-facing error.
 *
 * @param raw - The submitted value, untrusted.
 * @param bounds - The inclusive range the amount must fall in.
 *   Bounds that are not safe integers, or a min above max, refuse everything.
 * @returns The amount in sats, or null when the value is not acceptable.
 */
export function parseSatsAmount(
  raw: unknown,
  bounds: SatsAmountBounds,
): number | null {
  const { min = 1, max } = bounds;
  if (!Number.isSafeInteger(max) || !Number.isSafeInteger(min) || max < min) {
    return null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  // More digits than the ceiling can only be over it; this keeps parseInt
  // off very long strings.
  if (raw.length > String(max).length) {
    return null;
  }
  if (!SATS_AMOUNT_PATTERN.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}
