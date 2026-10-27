const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findUniqueUserByAadObjectId,
  listPeople,
  parseExtra,
} = require('./lnbitsUserDirectory');

test('parses object and JSON-string LNbits user metadata', () => {
  assert.deepEqual(parseExtra({ extra: { aadObjectId: 'aad-1' } }), {
    aadObjectId: 'aad-1',
  });
  assert.deepEqual(parseExtra({ extra: '{"aadObjectId":"aad-2"}' }), {
    aadObjectId: 'aad-2',
  });
  assert.deepEqual(parseExtra({ extra: 'not-json' }), {});
});

test('finds a user by application-level aadObjectId metadata', () => {
  const users = [
    { id: 'user-1', extra: { aadObjectId: 'aad-1' } },
    { id: 'user-2', extra: { aadObjectId: 'aad-2' } },
  ];

  assert.equal(findUniqueUserByAadObjectId(users, 'aad-2'), users[1]);
  assert.equal(findUniqueUserByAadObjectId(users, 'aad-missing'), null);
});

test('finds an LNbits v1 user by external_id', () => {
  const users = [
    { id: 'user-1', external_id: 'aad-1' },
    { id: 'user-2', external_id: 'aad-2' },
  ];

  assert.equal(findUniqueUserByAadObjectId(users, 'aad-2'), users[1]);
});

test('fails loud for malformed or ambiguous directory data', () => {
  assert.throws(
    () => findUniqueUserByAadObjectId(null, 'aad-1'),
    /LNbits users response is not an array/,
  );
  assert.throws(
    () =>
      findUniqueUserByAadObjectId(
        [
          { id: 'user-1', extra: { aadObjectId: 'aad-1' } },
          { id: 'user-2', aadObjectId: 'aad-1' },
        ],
        'aad-1',
      ),
    /More than one LNbits user is linked/,
  );
});

test('lists people by Entra id and name only, never wallets or keys', () => {
  const OID_A = 'AAAAAAAA-1111-2222-3333-444444444444';
  const OID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
  const users = [
    {
      id: 'user-1',
      external_id: OID_A,
      username: 'zed',
      extra: { display_name: 'Zed Person', adminkey: 'never-returned' },
      wallets: [{ adminkey: 'never-returned' }],
    },
    { id: 'user-2', extra: { aadObjectId: OID_B }, username: 'amy' },
    { id: 'treasury', username: 'automation' },
    { id: 'user-3', external_id: 'not-a-guid' },
  ];

  assert.deepEqual(listPeople(users), [
    { personAad: OID_B, displayName: 'amy' },
    { personAad: OID_A.toLowerCase(), displayName: 'Zed Person' },
  ]);
  assert.throws(() => listPeople(null), /not an array/);
});
