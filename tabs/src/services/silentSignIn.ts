// Support for signing the Teams tab in silently (MSAL ssoSilent), shared by
// the sign-in page, the logout handler and the app's startup.

// Set once a silent sign-in has been tried in this tab session, so a failure
// falls back to the Sign In button instead of retrying on every render.
export const SILENT_SIGN_IN_GUARD_KEY = 'zaplie.sso.attempted';

// Used when sessionStorage is unavailable (blocked storage, some embedded
// browsers): one attempt per page load is still better than a retry loop.
let attemptedWithoutStorage = false;

export const hasAttemptedSilentSignIn = (): boolean => {
  try {
    return sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY) !== null;
  } catch {
    return attemptedWithoutStorage;
  }
};

export const markSilentSignInAttempted = (): void => {
  attemptedWithoutStorage = true;
  try {
    sessionStorage.setItem(SILENT_SIGN_IN_GUARD_KEY, '1');
  } catch {
    // The in-memory flag above covers this page load.
  }
};

export const clearSilentSignInGuard = (): void => {
  attemptedWithoutStorage = false;
  try {
    sessionStorage.removeItem(SILENT_SIGN_IN_GUARD_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
};

// MSAL 5 runs ssoSilent in a hidden iframe that loads the app's redirect URI
// (the site root) with the sign-in response in the URL, and waits for that
// page to hand the response back over a BroadcastChannel. True for exactly
// that page load: framed, with an authorization response in the URL.
export const isSilentSignInResponse = (win: Window = window): boolean => {
  let framed: boolean;
  try {
    framed = win.parent !== win;
  } catch {
    framed = true;
  }
  if (!framed) {
    return false;
  }

  const params = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  new URLSearchParams(win.location.search).forEach((value, key) => {
    if (!params.has(key)) {
      params.set(key, value);
    }
  });
  return params.has('state') && (params.has('code') || params.has('error'));
};

// Hands the response to the waiting tab instead of starting the app inside
// the hidden iframe. A failure here only means the tab's ssoSilent times out
// and the Sign In button stays.
export const relaySilentSignInResponse = async (): Promise<void> => {
  try {
    const { broadcastResponseToMainFrame } =
      await import('@azure/msal-browser/redirect-bridge');
    await broadcastResponseToMainFrame();
  } catch (error) {
    console.debug('Could not return the silent sign-in response', error);
  }
};
