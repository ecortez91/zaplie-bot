import { positiveIntFromEnv } from './envNumbers';

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
