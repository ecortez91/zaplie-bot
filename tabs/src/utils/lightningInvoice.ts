import { decode } from 'light-bolt11-decoder';

export interface ParsedInvoice {
  amountSats: number;
  memo: string | null;
}

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
    throw new Error('The invoice must include an amount.');
  }

  // light-bolt11-decoder hands the millisatoshi amount back as a decimal
  // string. `Number()` would take '1e21' or a value past MAX_SAFE_INTEGER and
  // round it, so the read-only box could show an amount that is not the one
  // encoded in the invoice. The invoice itself is what gets paid, so this
  // misleads rather than misdirects money - still worth refusing.
  const amountMsat = /^\d+$/.test(rawAmount)
    ? Number.parseInt(rawAmount, 10)
    : NaN;

  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('The invoice amount could not be read.');
  }

  return {
    amountSats: amountMsat / 1000,
    memo:
      descriptionSection?.name === 'description'
        ? descriptionSection.value
        : null,
  };
};
