import { bech32 } from '@scure/base';
import {
  INVOICE_ERRORS,
  isInvoiceErrorMessage,
  parseInvoice,
} from './lightningInvoice';

// A real, checksum-valid mainnet invoice from the BOLT11 test vectors. Its
// data words are reused below with different human-readable prefixes so each
// case is a genuine invoice the decoder accepts, not a hand-written string it
// would reject on the checksum before reaching any of our own guards.
const BASE_INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

const BASE_WORDS = bech32.decode(BASE_INVOICE, Infinity as never).words;

/** Re-encode the sample invoice under a new prefix, recomputing the checksum. */
const invoiceWithPrefix = (prefix: string): string =>
  bech32.encode(prefix, BASE_WORDS, Infinity as never);

describe('parseInvoice amounts', () => {
  test.each([
    ['micro-BTC (2500u)', 'lnbc2500u', 250_000],
    ['milli-BTC (20m)', 'lnbc20m', 2_000_000],
    ['nano-BTC (10n)', 'lnbc10n', 1],
    ['testnet prefix (lntb20m)', 'lntb20m', 2_000_000],
  ])('reads %s as whole sats', (_label, prefix, expectedSats) => {
    expect(parseInvoice(invoiceWithPrefix(prefix)).amountSats).toBe(
      expectedSats,
    );
  });

  test('reads the invoice description', () => {
    expect(parseInvoice(invoiceWithPrefix('lnbc20m')).memo).toBe(
      '1 cup coffee',
    );
  });

  test('accepts an uppercase invoice', () => {
    const upper = invoiceWithPrefix('lnbc20m').toUpperCase();
    expect(parseInvoice(upper).amountSats).toBe(2_000_000);
  });

  // The regression this guard exists for: the pico-BTC multiplier can encode a
  // tenth of a sat, and a bare `/ 1000` rendered this as '967878.534'.
  test('refuses a sub-satoshi amount rather than showing a fraction', () => {
    expect(() => parseInvoice(invoiceWithPrefix('lnbc9678785340p'))).toThrow(
      INVOICE_ERRORS.subSatoshiAmount,
    );
  });

  test('refuses an amountless invoice', () => {
    expect(() => parseInvoice(invoiceWithPrefix('lnbc'))).toThrow(
      INVOICE_ERRORS.missingAmount,
    );
  });

  test('propagates the decoder error for a malformed invoice', () => {
    // Not one of our messages, so SendPayment shows the generic line instead
    // of this text - see the SendPayment rendering tests.
    const thrown = (() => {
      try {
        parseInvoice('lnbc1');
        return null;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(thrown).toBeInstanceOf(Error);
    expect(isInvoiceErrorMessage(thrown?.message ?? '')).toBe(false);
  });
});

describe('isInvoiceErrorMessage', () => {
  test('recognises only the messages this module raises', () => {
    Object.values(INVOICE_ERRORS).forEach(message => {
      expect(isInvoiceErrorMessage(message)).toBe(true);
    });
    expect(isInvoiceErrorMessage('Wrong string length: 5 (lnbc1).')).toBe(
      false,
    );
  });
});
