// typeGuards.ts
//
// Narrowing helpers shared by the modules that read untrusted JSON — LNbits
// responses and model-composed tool arguments. One copy so a fix lands
// everywhere instead of in whichever copy the next reader happens to open.

/**
 * Narrows an unknown value to a JSON object.
 *
 * Arrays are excluded deliberately: `typeof [] === 'object'`, so a guard that
 * only checks `typeof`/`null` lets `[]` reach code that destructures named
 * properties. Every caller here wants a keyed object, never a list.
 *
 * @param value - The value to test.
 * @returns `true` when the value is a non-null, non-array object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
