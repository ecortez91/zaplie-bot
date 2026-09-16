// paymentExtra.test.ts
//
// The payment metadata projection is the only thing standing between a
// Wallet object (adminkey, inkey, balance) and the LNbits payment ledger that
// other users can read, so every field it copies is pinned here.

import { describe, expect, test } from '@jest/globals';
import { PaymentExtraWallet, toPaymentExtraWallet } from './paymentExtra';

const wallet: Wallet = {
  id: 'wallet-1',
  admin: 'admin-1',
  name: 'Allowance',
  user: 'user-1',
  adminkey: 'wallet-1-adminkey',
  inkey: 'wallet-1-inkey',
  balance_msat: 21000,
  deleted: false,
};

describe('toPaymentExtraWallet', () => {
  test('copies only id, name, user and displayName', () => {
    const withJunk = { ...wallet, currency: 'sat' } as Wallet;

    expect(toPaymentExtraWallet(withJunk, 'sender Allowance', 'Ada')).toEqual({
      id: 'wallet-1',
      name: 'Allowance',
      user: 'user-1',
      displayName: 'Ada',
    });
  });

  test('omits displayName when not provided', () => {
    expect(
      Object.keys(toPaymentExtraWallet(wallet, 'sender Allowance')),
    ).toEqual(['id', 'name', 'user']);
    expect(
      Object.keys(toPaymentExtraWallet(wallet, 'sender Allowance', '')),
    ).toEqual(['id', 'name', 'user']);
  });

  test('a Wallet is not assignable to the projection', () => {
    // @ts-expect-error a Wallet carries keys and must not type-check here
    const rejected: PaymentExtraWallet = wallet;
    expect(rejected).toBeDefined();
  });

  test('throws when the wallet is missing', () => {
    expect(() => toPaymentExtraWallet(null, 'sender Allowance')).toThrow(
      /sender Allowance wallet is missing/,
    );
    expect(() => toPaymentExtraWallet(undefined, 'receiver Private')).toThrow(
      /receiver Private wallet is missing/,
    );
  });
});
