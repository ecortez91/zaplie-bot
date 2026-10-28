// The reward name is the label every portal page puts after an amount ("21
// sats"), and GET /api/reward-name serves it to anyone before sign-in. It is
// validated here, not at the route, so the write and the read apply the same
// rules: a short, single line of plain text.
//
// tabs/src/apiService.tsx keeps a copy of these rules so the Settings field can
// explain a refusal before the request is sent; the two are kept identical on
// purpose, and this one is the enforcement point.
const MAX_REWARD_NAME_LENGTH = 32;

// What the portal and the read fall back to when nothing valid is stored.
const DEFAULT_REWARD_NAME = 'sats';

// A label is one line, so unlike the persona there is no exception for tab or
// newline: all of C0, DEL and C1 are refused, plus U+2028/U+2029, which are in
// neither range but break lines in browsers and editors all the same.
const hasControlCharacter = value =>
  [...value].some(character => {
    const code = character.codePointAt(0);
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });

const validateRewardName = value => {
  if (typeof value !== 'string') {
    return { valid: false, message: 'The reward name must be text.' };
  }
  // Checked before trimming: trim() would quietly drop a newline, tab or
  // U+2028 sitting at either end instead of refusing it.
  if (hasControlCharacter(value)) {
    return {
      valid: false,
      message:
        'The reward name must be one line of plain text, without control characters.',
    };
  }

  const rewardName = value.trim();
  if (!rewardName) {
    return { valid: false, message: 'The reward name cannot be empty.' };
  }
  // Code points, not UTF-16 units, so an emoji is not billed twice against a
  // limit the message states in characters.
  if ([...rewardName].length > MAX_REWARD_NAME_LENGTH) {
    return {
      valid: false,
      message: `The reward name must be at most ${MAX_REWARD_NAME_LENGTH} characters.`,
    };
  }

  return { valid: true, value: rewardName };
};

// A stored value can predate these rules (or be hand-edited in data.json), so
// the open read sanitizes too instead of serving whatever is on disk. The
// reason is logged, never the value, which is exactly the text under
// suspicion. Nothing stored at all is the normal first-run state, not a fault.
const readStoredRewardName = stored => {
  if (stored === undefined) {
    return DEFAULT_REWARD_NAME;
  }
  const validation = validateRewardName(stored);
  if (!validation.valid) {
    const length = typeof stored === 'string' ? stored.length : 'n/a';
    console.warn(
      `Ignoring the stored rewardName: ${validation.message} (length: ${length})`,
    );
    return DEFAULT_REWARD_NAME;
  }
  return validation.value;
};

module.exports = {
  DEFAULT_REWARD_NAME,
  MAX_REWARD_NAME_LENGTH,
  validateRewardName,
  readStoredRewardName,
};
