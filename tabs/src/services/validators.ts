// Shared runtime guards for the portal's API response parsers. Kept in one
// place so every parser agrees on what "a number" means — `typeof value ===
// 'number'` alone accepts NaN and Infinity, which then render as "NaN sats".

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
