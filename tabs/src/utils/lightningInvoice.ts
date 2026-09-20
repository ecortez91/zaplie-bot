import { decode } from 'light-bolt11-decoder';

export interface ParsedInvoice {
  amountSats: number;
  memo: string | null;
}

// The only messages this module raises. `SendPayment` shows these to the user
// verbatim and replaces anything else with a generic line, so decoder internals
// like 'Wrong string length: 5 (lnbc1). Expected (8..9007199254740991)' never
// reach the payment screen.
export const INVOICE_ERRORS = {
  missingAmount: 'The invoice must include an amount.',
  unreadableAmount: 'The invoice amount could not be read.',
  subSatoshiAmount:
    'The invoice is for a fraction of a sat, which cannot be shown here.',
  undecodable: 'Enter a valid Lightning invoice.',
} as const;

const OWNED_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(INVOICE_ERRORS),
);

/** True when `message` is one this module raises, so it is safe to display. */
export const isInvoiceErrorMessage = (message: string): boolean =>
  OWNED_MESSAGES.has(message);

const MSAT_PER_SAT = 1000;

export const parseInvoice = (paymentRequest: string): ParsedInvoice => {
  const decodedInvoice = decode(paymentRequest);
  const amountSection = decodedInvoice.sections.find(
    section => section.name === 'amount',
  );
  const descriptionSection = decodedInvoice.sections.find(
    section => section.name === 'description',
  );
  const rawAmount =
    amountSection?.name === 'amount' ? amountSection.value : null;

  if (rawAmount === null) {
    throw new Error(INVOICE_ERRORS.missingAmount);
  }

  // light-bolt11-decoder hands the millisatoshi amount back as a decimal
  // string. `Number()` would take '1e21' or a value past MAX_SAFE_INTEGER and
  // round it, so the read-only box could show an amount that is not the one
  // encoded in the invoice.
  const amountMsat = /^\d+$/.test(rawAmount)
    ? Number.parseInt(rawAmount, 10)
    : NaN;

  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
    throw new Error(INVOICE_ERRORS.unreadableAmount);
  }

  // BOLT11 amounts are millisatoshi, and the `p` (pico-BTC) multiplier can
  // encode a tenth of a sat: `lnbc9678785340p` is 967878534 msat, which a bare
  // `/ 1000` renders as '967878.534'. Every balance, zap and allowance in this
  // app is whole sats, so there is no honest way to show that figure - and
  // rounding it on a payment screen is the sort of quiet inaccuracy this guard
  // exists to prevent. Refuse it instead.
  if (amountMsat % MSAT_PER_SAT !== 0) {
    throw new Error(INVOICE_ERRORS.subSatoshiAmount);
  }

  return {
    amountSats: amountMsat / MSAT_PER_SAT,
    memo:
      descriptionSection?.name === 'description'
        ? descriptionSection.value
        : null,
  };
};
