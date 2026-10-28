import { UserFacingError } from '../messages';
import { expect, describe, test } from '@jest/globals';
import { validateZapSubmit } from './zapBudget';

describe('validateZapSubmit', () => {
  test('returns the parsed amount for a valid single zap', () => {
    expect(validateZapSubmit('100', 1, 100, 'Sats')).toBe(100);
  });

  test('rejects the cumulative total across recipients, not just one', () => {
    // 3 x 100 = 300 against a 100 balance: the bug this guard closes
    expect(() => validateZapSubmit('100', 3, 100, 'Sats')).toThrow(
      'That would send 300 Sats across 3 recipient(s) but your balance is 100',
    );
  });

  test('rejects a negative forged amount', () => {
    expect(() => validateZapSubmit('-100', 1, 1000, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('rejects a fractional amount', () => {
    expect(() => validateZapSubmit('0.5', 1, 1000, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('rejects an amount over the cap', () => {
    expect(() => validateZapSubmit('10001', 1, 999999, 'Sats')).toThrow(
      'whole number between 1 and 10,000',
    );
  });

  test('allows spending the exact balance', () => {
    expect(validateZapSubmit('50', 2, 100, 'Sats')).toBe(50);
  });

  test('rejects a NaN balance instead of skipping the budget check', () => {
    expect(() => validateZapSubmit('100', 1, NaN, 'Sats')).toThrow(
      'Could not read your live balance',
    );
  });

  test('rejects a non-finite balance', () => {
    expect(() => validateZapSubmit('100', 1, Infinity, 'Sats')).toThrow(
      'Could not read your live balance',
    );
  });

  test('rejects a negative balance', () => {
    expect(() => validateZapSubmit('100', 1, -50, 'Sats')).toThrow(
      'Could not read your live balance',
    );
  });

  test('rejects zero recipients', () => {
    expect(() => validateZapSubmit('100', 0, 1000, 'Sats')).toThrow(
      'No valid recipients',
    );
  });

  test('rejects a negative recipient count', () => {
    expect(() => validateZapSubmit('100', -1, 1000, 'Sats')).toThrow(
      'No valid recipients',
    );
  });

  test('rejects a fractional recipient count', () => {
    expect(() => validateZapSubmit('100', 1.5, 1000, 'Sats')).toThrow(
      'No valid recipients',
    );
  });
});

describe('validateZapSubmit errors carry a message key', () => {
  test('so the handler can render them in the user language', () => {
    let caught: unknown;
    try {
      validateZapSubmit('100', 3, 100, 'Sats');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserFacingError);
    const error = caught as UserFacingError;
    expect(error.key).toBe('budgetExceeded');
    expect(error.localized('es')).toBe(
      'Eso enviaría 300 Sats entre 3 destinatario(s), pero tu saldo es 100. No se envió ningún zap.',
    );
    expect(error.message).toBe(error.localized('en'));
  });
});

// The card only lets plain digits through; the server must apply the same
// rule, because Number() turns a forged '1e3' into 1,000 sats and '1.000'
// into 1. The balance is large so only the amount rule is in play.
describe('validateZapSubmit parses the amount like the card does', () => {
  const RANGE_ERROR = 'whole number between 1 and 10,000';
  const submit = (rawAmount: unknown): number =>
    validateZapSubmit(rawAmount, 1, 1_000_000, 'Sats');

  test.each([
    ['an exponent', '1e3'],
    ['a thousands separator', '1.000'],
    ['a plus sign', '+1'],
    ['a hex prefix', '0x10'],
    ['padding', ' 5 '],
    ['a trailing newline', '5\n'],
    ['leading zeros', '0010'],
    ['a boolean', true],
    ['an array', ['5']],
    ['a JSON number', 100],
    ['an empty string', ''],
    ['a minus sign', '-5'],
    ['zero', '0'],
    ['a decimal', '1.5'],
    ['one over the cap', '10001'],
    ['a value past the safe integer range', '9007199254740993'],
    ['a 401-digit string', '1' + '0'.repeat(400)],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_name, rawAmount) => {
    let caught: unknown;
    try {
      submit(rawAmount);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserFacingError);
    expect((caught as UserFacingError).message).toContain(RANGE_ERROR);
  });

  test('a forged amount gets the existing amountInvalid error, in Spanish too', () => {
    let caught: unknown;
    try {
      submit('1e3');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UserFacingError);
    const error = caught as UserFacingError;
    expect(error.key).toBe('amountInvalid');
    expect(error.localized('es-ES')).toBe(
      'Debes indicar un número entero entre 1 y 10.000 Sats.',
    );
  });

  test('plain digits give the same numbers as before', () => {
    expect(submit('1')).toBe(1);
    expect(submit('100')).toBe(100);
    expect(submit('10000')).toBe(10000);
  });
});
