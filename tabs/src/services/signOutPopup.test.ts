import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
  SIGN_OUT_RELAY_TIMEOUT_MS,
  isSignOutPopupResponse,
  relaySignOutPopupResponse,
} from './signOutPopup';

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

// An MSAL state value as msal-common setRequestState builds it with
// msal-browser's base64Encode: standard, padded base64 JSON of { id, meta },
// optionally followed by '|' and the caller's state. This id makes the JSON a
// length that needs '=' padding.
const msalState = (interactionType: string, userState = ''): string => {
  const library = btoa(
    JSON.stringify({
      id: '019a1c3e-1b2c-7d4e-8f90-abcdef123456',
      meta: { interactionType },
    }),
  );
  return userState ? `${library}|${userState}` : library;
};

// The same state in the base64url alphabet without padding, which the decoder
// also accepts.
const base64UrlState = (interactionType: string): string =>
  msalState(interactionType)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fakeWindow = (
  url: string,
  framed: boolean | 'cross-origin-throws' = false,
): Window => {
  const { search, pathname } = new URL(url);
  const win: {
    location: { search: string; pathname: string };
    parent?: unknown;
    close: () => void;
  } = { location: { search, pathname }, close: jest.fn() };
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

const popupState = encodeURIComponent(msalState('popup'));
const redirectState = encodeURIComponent(msalState('redirect'));

describe('isSignOutPopupResponse', () => {
  test('is true for the sign-out popup landing on /login with a popup state', () => {
    expect(
      isSignOutPopupResponse(
        fakeWindow(`https://zaplie.test/login?state=${popupState}`),
      ),
    ).toBe(true);
    expect(
      isSignOutPopupResponse(
        fakeWindow(`https://zaplie.test/login/?state=${popupState}`),
      ),
    ).toBe(true);
    expect(
      isSignOutPopupResponse(
        fakeWindow(
          `https://zaplie.test/login?state=${encodeURIComponent(
            msalState('popup', 'caller-state'),
          )}`,
        ),
      ),
    ).toBe(true);
  });

  test('also accepts a base64url state', () => {
    expect(
      isSignOutPopupResponse(
        fakeWindow(
          `https://zaplie.test/login?state=${base64UrlState('popup')}`,
        ),
      ),
    ).toBe(true);
  });

  test.each([
    [
      'a full-page sign-out landing (redirect state), which must boot the app',
      `https://zaplie.test/login?state=${redirectState}`,
      false,
    ],
    ['the sign-in page with no state', 'https://zaplie.test/login', false],
    [
      'a state that is not an MSAL state',
      'https://zaplie.test/login?state=not-msal',
      false,
    ],
    [
      'a popup state on another route',
      `https://zaplie.test/feed?state=${popupState}`,
      false,
    ],
    [
      'a popup state on the redirect URI (base path)',
      `https://zaplie.test/?state=${popupState}`,
      false,
    ],
    [
      'the Teams auth window at /auth-end',
      `https://zaplie.test/auth-end?code=abc&state=${redirectState}`,
      false,
    ],
    [
      'a framed /login with a popup state',
      `https://zaplie.test/login?state=${popupState}`,
      true,
    ],
    [
      'the silent sign-in iframe',
      `https://zaplie.test/#code=abc&state=${popupState}`,
      true,
    ],
  ])('is false for %s', (_case, url, framed) => {
    expect(isSignOutPopupResponse(fakeWindow(url, framed))).toBe(false);
  });

  test('is false when the parent cannot even be read (a cross-origin frame)', () => {
    expect(
      isSignOutPopupResponse(
        fakeWindow(
          `https://zaplie.test/login?state=${popupState}`,
          'cross-origin-throws',
        ),
      ),
    ).toBe(false);
  });

  test('uses /portal/login under the portal base path', () => {
    const publicUrl = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = '/portal';
    try {
      expect(
        isSignOutPopupResponse(
          fakeWindow(`https://getzapl.ie/portal/login?state=${popupState}`),
        ),
      ).toBe(true);
      expect(
        isSignOutPopupResponse(
          fakeWindow(`https://getzapl.ie/login?state=${popupState}`),
        ),
      ).toBe(false);
    } finally {
      process.env.PUBLIC_URL = publicUrl;
    }
  });
});

describe('relaySignOutPopupResponse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockBroadcast.mockReset();
  });

  test('hands the response to the waiting tab and closes the popup', async () => {
    mockBroadcast.mockResolvedValue(undefined);
    const win = fakeWindow(`https://zaplie.test/login?state=${popupState}`);

    await relaySignOutPopupResponse(win);

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalled();
  });

  test('still closes the popup, and never throws, when the hand-off fails', async () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    mockBroadcast.mockRejectedValue(new Error('no response'));
    const win = fakeWindow(`https://zaplie.test/login?state=${popupState}`);

    await expect(relaySignOutPopupResponse(win)).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalled();
    expect(win.close).toHaveBeenCalled();
  });

  test('closes the popup when the hand-off never settles', async () => {
    jest.useFakeTimers();
    try {
      const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
      mockBroadcast.mockReturnValue(new Promise(() => undefined));
      const win = fakeWindow(`https://zaplie.test/login?state=${popupState}`);

      const relay = relaySignOutPopupResponse(win);
      jest.advanceTimersByTime(SIGN_OUT_RELAY_TIMEOUT_MS);
      await relay;

      expect(win.close).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
