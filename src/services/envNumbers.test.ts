import { nonNegativeIntFromEnv, positiveIntFromEnv } from './envNumbers';

const NAME = 'REWARDS_MAX_AMOUNT_SATS';

describe('positiveIntFromEnv', () => {
  const original = process.env[NAME];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = original;
    }
  });

  it('falls back when the variable is unset or blank', () => {
    delete process.env[NAME];
    expect(positiveIntFromEnv(NAME, 10000)).toBe(10000);
    process.env[NAME] = '';
    expect(positiveIntFromEnv(NAME, 10000)).toBe(10000);
    process.env[NAME] = '   ';
    expect(positiveIntFromEnv(NAME, 10000)).toBe(10000);
  });

  it('accepts a configured decimal integer', () => {
    process.env[NAME] = '250';
    expect(positiveIntFromEnv(NAME, 10000)).toBe(250);
    process.env[NAME] = ' 1000 ';
    expect(positiveIntFromEnv(NAME, 10000)).toBe(1000);
  });

  it('rejects the forms Number() would have silently reinterpreted', () => {
    // The portal backend rejects every one of these; the bot must agree, or a
    // single deployment-wide variable means two different caps.
    for (const malformed of [
      '1e3',
      '0x10',
      '10000.0',
      '1.5',
      '-1',
      '0',
      'not-a-number',
      '9007199254740993',
      'Infinity',
    ]) {
      process.env[NAME] = malformed;
      expect(() => positiveIntFromEnv(NAME, 10000)).toThrow(
        `${NAME} must be a positive integer`,
      );
    }
  });
});

describe('nonNegativeIntFromEnv', () => {
  const LEDGER_NAME = 'ZAPLIE_LEDGER_STALE_LOCK_MS';
  const original = process.env[LEDGER_NAME];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[LEDGER_NAME];
    } else {
      process.env[LEDGER_NAME] = original;
    }
  });

  it('falls back when the variable is unset or blank', () => {
    delete process.env[LEDGER_NAME];
    expect(nonNegativeIntFromEnv(LEDGER_NAME, 30000)).toBe(30000);
    process.env[LEDGER_NAME] = '  ';
    expect(nonNegativeIntFromEnv(LEDGER_NAME, 30000)).toBe(30000);
  });

  it('accepts 0 and a configured decimal integer', () => {
    process.env[LEDGER_NAME] = '0';
    expect(nonNegativeIntFromEnv(LEDGER_NAME, 30000)).toBe(0);
    process.env[LEDGER_NAME] = ' 120000 ';
    expect(nonNegativeIntFromEnv(LEDGER_NAME, 30000)).toBe(120000);
  });

  it('rejects anything that is not a plain whole number', () => {
    for (const malformed of [
      'abc',
      '1e3',
      '0x10',
      '1.5',
      '-1',
      '9007199254740993',
    ]) {
      process.env[LEDGER_NAME] = malformed;
      expect(() => nonNegativeIntFromEnv(LEDGER_NAME, 30000)).toThrow(
        `${LEDGER_NAME} must be a non-negative integer`,
      );
    }
  });
});
