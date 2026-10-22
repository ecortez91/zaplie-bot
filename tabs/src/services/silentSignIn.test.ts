import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  SILENT_SIGN_IN_GUARD_KEY,
  clearSilentSignInGuard,
  hasAttemptedSilentSignIn,
  isSilentSignInResponse,
  markSilentSignInAttempted,
  relaySilentSignInResponse,
} from './silentSignIn';

const mockBroadcast = jest.fn<Promise<void>, []>();

// The real module is a package "exports" subpath that CRA's Jest cannot
// resolve; the relay only needs its one function.
jest.mock(
  '@azure/msal-browser/redirect-bridge',
  () => ({
    broadcastResponseToMainFrame: () => mockBroadcast(),
  }),
  { virtual: true },
);

const fakeWindow = (
  url: string,
  framed: boolean | 'cross-origin-throws',
): Window => {
  const { hash, search, pathname } = new URL(url);
  const win: {
    location: { hash: string; search: string; pathname: string };
    parent?: unknown;
  } = { location: { hash, search, pathname } };
  if (framed === 'cross-origin-throws') {
    Object.defineProperty(win, 'parent', {
      get: () => {
        throw new Error('blocked');
      },
    });
  } else {
    win.parent = framed ? {} : win;
  }
  return win as unknown as Window;
};

describe('isSilentSignInResponse', () => {
  test.each([
    ['https://zaplie.test/#code=abc&state=xyz', true],
    ['https://zaplie.test/?code=abc&state=xyz', true],
    ['https://zaplie.test/#error=login_required&state=xyz', true],
  ])('a framed page with %s is the silent sign-in iframe', (url, expected) => {
    expect(isSilentSignInResponse(fakeWindow(url, true))).toBe(expected);
    expect(isSilentSignInResponse(fakeWindow(url, 'cross-origin-throws'))).toBe(
      expected,
    );
  });

  test.each([
    [
      'the Teams tab itself (framed, no response)',
      'https://zaplie.test/login',
      true,
    ],
    [
      'a framed page with a code but no state',
      'https://zaplie.test/#code=abc',
      true,
    ],
    [
      'a top-level page with a response',
      'https://zaplie.test/#code=abc&state=xyz',
      false,
    ],
  ])('is false for %s', (_case, url, framed) => {
    expect(isSilentSignInResponse(fakeWindow(url, framed))).toBe(false);
  });

  test('is false for a framed /auth-end with a response (the Teams auth popup)', () => {
    expect(
      isSilentSignInResponse(
        fakeWindow('https://zaplie.test/auth-end#code=abc&state=xyz', true),
      ),
    ).toBe(false);
  });

  test('accepts the base path, with or without a trailing slash, under /portal', () => {
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = '/portal';
    try {
      expect(
        isSilentSignInResponse(
          fakeWindow('https://getzapl.ie/portal#code=abc&state=xyz', true),
        ),
      ).toBe(true);
      expect(
        isSilentSignInResponse(
          fakeWindow('https://getzapl.ie/portal/#code=abc&state=xyz', true),
        ),
      ).toBe(true);
      expect(
        isSilentSignInResponse(
          fakeWindow('https://getzapl.ie/#code=abc&state=xyz', true),
        ),
      ).toBe(false);
    } finally {
      process.env.PUBLIC_URL = publicUrl;
    }
  });
});

describe('relaySilentSignInResponse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('hands the response to the waiting tab', async () => {
    mockBroadcast.mockResolvedValue(undefined);

    await relaySilentSignInResponse();

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  test('never throws when the hand-off fails', async () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    mockBroadcast.mockRejectedValue(new Error('no response'));

    await expect(relaySilentSignInResponse()).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
  });
});

describe('silent sign-in guard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearSilentSignInGuard();
  });

  test('is set, read and cleared through sessionStorage', () => {
    expect(hasAttemptedSilentSignIn()).toBe(false);

    markSilentSignInAttempted();
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBe('1');
    expect(hasAttemptedSilentSignIn()).toBe(true);

    clearSilentSignInGuard();
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBeNull();
    expect(hasAttemptedSilentSignIn()).toBe(false);
  });

  test('still allows only one attempt when sessionStorage throws', () => {
    const blocked = () => {
      throw new Error('storage blocked');
    };
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);

    expect(hasAttemptedSilentSignIn()).toBe(false);
    expect(() => markSilentSignInAttempted()).not.toThrow();
    expect(hasAttemptedSilentSignIn()).toBe(true);
    expect(() => clearSilentSignInGuard()).not.toThrow();
    expect(hasAttemptedSilentSignIn()).toBe(false);
  });

  test('keeps the guard when only the storage write fails', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    markSilentSignInAttempted();

    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBeNull();
    expect(hasAttemptedSilentSignIn()).toBe(true);
  });
});
