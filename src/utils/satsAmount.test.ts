import { describe, expect, test } from '@jest/globals';
import { parseSatsAmount, SATS_AMOUNT_PATTERN } from './satsAmount';

describe('parseSatsAmount', () => {
  const parse = (raw: unknown): number | null =>
    parseSatsAmount(raw, { max: 10000 });

  test('reads plain whole numbers within the bounds', () => {
    expect(parse('1')).toBe(1);
    expect(parse('100')).toBe(100);
    expect(parse('9999')).toBe(9999);
    expect(parse('10000')).toBe(10000);
  });

  test('refuses an amount above the maximum', () => {
    expect(parse('10001')).toBeNull();
  });

  test('treats both bounds as inclusive', () => {
    const bounds = { min: 5, max: 10 };
    expect(parseSatsAmount('1', bounds)).toBeNull();
    expect(parseSatsAmount('5', bounds)).toBe(5);
    expect(parseSatsAmount('10', bounds)).toBe(10);
    expect(parseSatsAmount('11', bounds)).toBeNull();
  });

  // Bounds come from the caller, so a bad pair must fail closed rather than
  // let any amount through: '5' <= NaN and '5' > NaN are both false.
  test.each([
    ['max NaN', { max: Number.NaN }],
    ['max Infinity', { max: Number.POSITIVE_INFINITY }],
    ['min above max', { min: 10, max: 5 }],
    ['non-integer max', { max: 10.5 }],
  ])('refuses any amount when the bounds are bad: %s', (_name, bounds) => {
    expect(parseSatsAmount('5', bounds)).toBeNull();
  });

  // Each of these is a number to Number(), which is how a forged submit paid
  // an amount the user never typed: 1e3 is 1,000 and 1.000 is 1.
  test.each([
    ['exponent', '1e3'],
    ['thousands separator', '1.000'],
    ['decimal', '1.5'],
    ['decimal zero', '1.0'],
    ['comma separator', '1,000'],
    ['plus sign', '+1'],
    ['minus sign', '-5'],
    ['hex prefix', '0x10'],
    ['binary prefix', '0b11'],
    ['octal prefix', '0o7'],
    ['padded', ' 5 '],
    ['leading space', ' 5'],
    ['trailing space', '5 '],
    ['trailing newline', '5\n'],
    ['leading tab', '\t5'],
    ['empty', ''],
    ['blank', ' '],
    ['zero', '0'],
    ['double zero', '00'],
    ['leading zeros', '0010'],
    ['leading zeros, short', '007'],
    ['Arabic-Indic digit', '٥'],
    ['fullwidth digit', '５'],
    ['mixed digits', '1٠'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['letters', 'abc'],
    ['trailing letters', '5abc'],
  ])('refuses %s (%j)', (_name, raw) => {
    expect(parse(raw)).toBeNull();
  });

  test('refuses a value past the safe integer range even under a huge max', () => {
    const bounds = { max: Number.MAX_SAFE_INTEGER };
    expect(parseSatsAmount('9007199254740993', bounds)).toBeNull();
    expect(parseSatsAmount('9007199254740991', bounds)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test('refuses a very long string without throwing', () => {
    expect(() => parse('1' + '0'.repeat(400))).not.toThrow();
    expect(parse('1' + '0'.repeat(400))).toBeNull();
  });

  // The card's Input.Text always submits a string, so anything else came
  // from outside the card.
  test.each([
    ['a number', 100],
    ['true', true],
    ['an array', ['5']],
    ['an object', {}],
    ['null', null],
    ['undefined', undefined],
    ['a bigint', BigInt(5)],
    ['a symbol', Symbol('5')],
  ])('refuses %s', (_name, raw) => {
    expect(parse(raw)).toBeNull();
  });

  test('states the rule as a pattern', () => {
    expect(SATS_AMOUNT_PATTERN.source).toBe('^[1-9][0-9]*$');
  });
});
