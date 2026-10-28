const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowanceDescription,
  allowanceUsername,
  desiredPayLink,
  ensureAllowancePayLink,
  findAllowancePayLink,
  publicLnbitsHost,
} = require('./payLinkService');

const OID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const RANGE = { minSats: 1000, maxSats: 1000, commentChars: 0 };
const WALLET = { id: 'w1', inkey: 'in', adminkey: 'admin' };

test('the username is zaplie- plus the first 12 hex digits of the oid, valid for lnurlp', () => {
  const username = allowanceUsername(OID.toUpperCase());
  assert.equal(username, 'zaplie-0a1b2c3d4e5f');
  assert.match(username, /^[a-z0-9-_.]{1,210}$/);
});

test('the description names the person on one line', () => {
  assert.equal(allowanceDescription('Ada\nLovelace'), 'Zaplie allowance (Ada Lovelace)');
  assert.equal(allowanceDescription(''), 'Zaplie allowance');
});

test('the public host comes from LNBITS_PUBLIC_HOST, else LNBITS_NODE_URL', () => {
  assert.equal(publicLnbitsHost({ LNBITS_PUBLIC_HOST: 'https://Bank.KnowAll.ai/' }), 'bank.knowall.ai');
  assert.equal(publicLnbitsHost({ LNBITS_NODE_URL: 'https://bank.knowall.ai' }), 'bank.knowall.ai');
  assert.equal(publicLnbitsHost({}), '');
});

test('the link is found by username first, then by the description prefix', () => {
  const byUsername = { id: 'a', username: allowanceUsername(OID), description: 'x' };
  const byDescription = { id: 'b', description: 'Zaplie allowance (old)' };
  assert.equal(findAllowancePayLink([byDescription, byUsername], OID), byUsername);
  assert.equal(findAllowancePayLink([{ id: 'c', description: 'Tips' }, byDescription], OID), byDescription);
  assert.equal(findAllowancePayLink([{ id: 'c', description: 'Tips' }], OID), null);
});

test('ensureAllowancePayLink creates a missing link with the wallet admin key', async () => {
  const created = [];
  const result = await ensureAllowancePayLink(
    { wallet: WALLET, oid: OID, displayName: 'Ada', range: RANGE },
    {
      listLinks: async () => [{ id: 'other', description: 'Tips' }],
      createLink: async (wallet, body) => {
        created.push({ wallet, body });
        return { id: 'new', ...body };
      },
      updateLink: async () => assert.fail('no update expected'),
    },
  );
  assert.equal(result.action, 'created');
  assert.equal(created[0].wallet, WALLET);
  assert.deepEqual(created[0].body, {
    description: 'Zaplie allowance (Ada)',
    min: 1000,
    max: 1000,
    comment_chars: 0,
    username: 'zaplie-0a1b2c3d4e5f',
  });
});

test('ensureAllowancePayLink leaves a matching link alone and updates a stale one', async () => {
  const desired = desiredPayLink({ oid: OID, displayName: 'Ada', range: RANGE });
  const noop = await ensureAllowancePayLink(
    { wallet: WALLET, oid: OID, displayName: 'Ada', range: RANGE, existing: { id: 'l1', ...desired } },
    { createLink: async () => assert.fail(), updateLink: async () => assert.fail() },
  );
  assert.equal(noop.action, 'noop');

  const updates = [];
  const stale = { id: 'l1', ...desired, max: 500, disposable: false, success_text: 'thanks' };
  const updated = await ensureAllowancePayLink(
    { wallet: WALLET, oid: OID, displayName: 'Ada', range: RANGE, existing: stale },
    {
      createLink: async () => assert.fail(),
      updateLink: async (wallet, id, body) => {
        updates.push({ id, body });
        return { id, ...body };
      },
    },
  );
  assert.equal(updated.action, 'updated');
  assert.equal(updates[0].id, 'l1');
  assert.equal(updates[0].body.max, 1000);
  // lnurlp's PUT replaces the whole link, so the link's own settings are resent.
  assert.equal(updates[0].body.disposable, false);
  assert.equal(updates[0].body.success_text, 'thanks');
});
