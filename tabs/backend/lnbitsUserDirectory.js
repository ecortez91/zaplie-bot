const parseExtra = (user) => {
  if (!user || user.extra === null || user.extra === undefined) {
    return {};
  }
  if (typeof user.extra === 'object' && !Array.isArray(user.extra)) {
    return user.extra;
  }
  if (typeof user.extra === 'string') {
    try {
      const parsed = JSON.parse(user.extra);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_error) {
      return {};
    }
  }
  return {};
};

const findUniqueUserByAadObjectId = (users, aadObjectId) => {
  if (!Array.isArray(users)) {
    throw new Error('LNbits users response is not an array');
  }
  const matches = users.filter((user) => {
    const extra = parseExtra(user);
    return (
      user?.external_id === aadObjectId ||
      user?.aadObjectId === aadObjectId ||
      extra.aadObjectId === aadObjectId
    );
  });
  if (matches.length > 1) {
    throw new Error(`More than one LNbits user is linked to Entra id ${aadObjectId}`);
  }
  return matches[0] || null;
};

const OID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 100;

/**
 * `[{ personAad, displayName }]` for every LNbits user linked to an Entra
 * object id, sorted by name. Only those two fields leave this function: no
 * wallet, key, balance or email.
 */
const listPeople = (users) => {
  if (!Array.isArray(users)) {
    throw new Error('LNbits users response is not an array');
  }
  const people = new Map();
  for (const user of users) {
    const extra = parseExtra(user);
    const candidate = user?.external_id || user?.aadObjectId || extra.aadObjectId;
    if (typeof candidate !== 'string' || !OID_PATTERN.test(candidate)) {
      continue;
    }
    const personAad = candidate.toLowerCase();
    const rawName = extra.display_name || user?.username || personAad;
    const displayName = String(rawName).slice(0, MAX_NAME_LENGTH);
    if (!people.has(personAad)) {
      people.set(personAad, { personAad, displayName });
    }
  }
  return [...people.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
};

module.exports = { findUniqueUserByAadObjectId, listPeople, parseExtra };
