// The reward name is shown on every portal page and served to visitors before
// sign-in, so the rules that keep it a short single-line label are unit-tested
// here; configRoutes.test.js only checks that the routes apply them.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  DEFAULT_REWARD_NAME,
  MAX_REWARD_NAME_LENGTH,
  validateRewardName,
  readStoredRewardName,
} = require('./rewardName');

test('a plain reward name is accepted and trimmed', () => {
  assert.deepEqual(validateRewardName('  Zaps  '), {
    valid: true,
    value: 'Zaps',
  });
});

test('a non-string reward name is rejected', () => {
  for (const value of [123, null, undefined, true, { x: 1 }, ['sats']]) {
    const result = validateRewardName(value);
    assert.equal(result.valid, false);
    assert.equal(result.message, 'The reward name must be text.');
  }
});

test('a blank reward name is rejected', () => {
  for (const value of ['', '   ']) {
    assert.deepEqual(validateRewardName(value), {
      valid: false,
      message: 'The reward name cannot be empty.',
    });
  }
});

test('the length limit counts code points, after trimming', () => {
  assert.equal(MAX_REWARD_NAME_LENGTH, 32);
  const atLimit = 'a'.repeat(MAX_REWARD_NAME_LENGTH);
  assert.deepEqual(validateRewardName(`  ${atLimit}  `), {
    valid: true,
    value: atLimit,
  });

  // An emoji is two UTF-16 units but one character to the admin.
  const withEmoji = `${'a'.repeat(MAX_REWARD_NAME_LENGTH - 1)}⚡`;
  assert.equal(validateRewardName(withEmoji).valid, true);
  const emojiOnly = '🎉'.repeat(MAX_REWARD_NAME_LENGTH);
  assert.equal(validateRewardName(emojiOnly).valid, true);

  assert.deepEqual(validateRewardName('a'.repeat(MAX_REWARD_NAME_LENGTH + 1)), {
    valid: false,
    message: 'The reward name must be at most 32 characters.',
  });
});

test('control characters, line breaks and tabs are rejected anywhere', () => {
  const values = [
    'sa\u0000ts',
    'sa\nts',
    'sa\tts',
    'sa\rts',
    'sa\u007fts',
    'sa\u0085ts',
    'sa\u009fts',
    'sa\u2028ts',
    'sa\u2029ts',
    // Trimming would swallow these at either end, so the check runs first.
    '\nsats',
    'sats\t',
    '\u2028sats',
    'sats\u2029',
  ];
  for (const value of values) {
    assert.deepEqual(
      validateRewardName(value),
      {
        valid: false,
        message:
          'The reward name must be one line of plain text, without control characters.',
      },
      JSON.stringify(value),
    );
  }
});

test('ordinary punctuation and accented letters are allowed', () => {
  for (const value of ['Zaps!', 'Puntos de reconocimiento', 'Kudos (beta)', 'Ñandú']) {
    assert.equal(validateRewardName(value).valid, true, value);
  }
});

test('a valid stored reward name is returned trimmed', () => {
  assert.equal(readStoredRewardName('  Zaps '), 'Zaps');
});

test('a stored reward name that breaks the rules reads as the default', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  try {
    for (const stored of [12, { x: 1 }, ['sats'], '', '   ', 'x'.repeat(33), 'sa\u0000ts']) {
      assert.equal(readStoredRewardName(stored), DEFAULT_REWARD_NAME);
    }
  } finally {
    console.warn = original;
  }
  assert.equal(DEFAULT_REWARD_NAME, 'sats');
  // The reason is logged, never the value under suspicion.
  assert.equal(warnings.length, 7);
  assert.ok(warnings.every(line => !line.includes('xxxxxxxx')));
});

test('a reward name that was never saved reads as the default without a warning', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  try {
    assert.equal(readStoredRewardName(undefined), DEFAULT_REWARD_NAME);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 0);
});
