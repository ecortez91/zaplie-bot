// walletNames.ts
//
// Zaplie identifies a member's two wallets by name convention: "Allowance" is
// the spending budget zaps are sent from, "Private" is where received zaps
// land. The match is case-insensitive because LNbits echoes back whatever
// casing created the wallet, and a stricter check here than in the leaderboard
// would let a wallet count towards a ranking yet vanish from a balance reply.
//
// One home for the rule so the bot cannot disagree with itself about it.

export const WALLET_NAME_ALLOWANCE = 'Allowance';
export const WALLET_NAME_PRIVATE = 'Private';

export const isAllowanceWallet = (walletName: string): boolean =>
  walletName?.toLowerCase() === WALLET_NAME_ALLOWANCE.toLowerCase();

export const isPrivateWallet = (walletName: string): boolean =>
  walletName?.toLowerCase() === WALLET_NAME_PRIVATE.toLowerCase();
