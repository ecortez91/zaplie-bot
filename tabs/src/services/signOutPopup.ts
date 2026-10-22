// The landing page of the Teams sign-out popup (MSAL logoutPopup).
//
// How MSAL 5.24 finishes logoutPopup (@azure/msal-browser src):
// - interaction_client/PopupClient.ts logoutPopupAsync stamps the end-session
//   request's state with { interactionType: 'popup' }, opens the popup and
//   waits in waitForPopupResponse -> utils/BrowserUtils.ts
//   waitForBridgeResponse, which listens on a BroadcastChannel named after the
//   state's id until popupBridgeTimeout (60 s). It never reads or closes the
//   popup itself.
// - The page Entra sends the popup back to (postLogoutRedirectUri, here
//   /login?state=...) has to run redirect_bridge/index.ts
//   broadcastResponseToMainFrame, which posts the response on that channel and
//   calls window.close(). Without it the popup stays open and boots the whole
//   app, still inside MSAL's sign-out interaction (issue 508).
//
// So, like the silent sign-in iframe (silentSignIn.ts), that page load only
// relays the response and never starts the app.

import { getBasePath } from './appLocation';

// Decodes the library part of an MSAL state value (base64url JSON, then an
// optional '|' and the caller's own state), as msal-common ProtocolUtils
// parseRequestState does. Null for anything that is not one.
const readInteractionType = (state: string): string | null => {
  try {
    const encoded = state.split('|')[0].replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const libraryState = JSON.parse(atob(padded)) as {
      id?: unknown;
      meta?: { interactionType?: unknown };
    };
    const interactionType = libraryState?.meta?.interactionType;
    return typeof libraryState?.id === 'string' &&
      typeof interactionType === 'string'
      ? interactionType
      : null;
  } catch {
    return null;
  }
};

// True for exactly the page Entra returns the sign-out popup to: a top-level
// window at the post-logout route (/login under the base path) whose state
// MSAL created for a popup. This mirrors MSAL's own BrowserUtils.isInPopup
// (not framed, state meta interactionType === 'popup') rather than checking
// window.opener: the popup went through login.microsoftonline.com, and MSAL
// documents that COOP breaks the opener link of a popup that navigates to the
// identity provider (msal-browser src/popup_relay/index.ts runPopupRelay and
// the auth.popupRelayUri notes in src/config/Configuration.ts).
// - A logoutRedirect lands on the same /login?state=... with interactionType
//   'redirect' and boots the app, where handleRedirectPromise clears it.
// - The app never uses loginPopup (Teams sign-in runs loginRedirect in the
//   Teams window, AuthStart -> /auth-end), so no sign-in lands here.
// - The silent sign-in iframe is framed and at the base path, never /login.
export const isSignOutPopupResponse = (win: Window = window): boolean => {
  let framed: boolean;
  try {
    framed = win.parent !== win;
  } catch {
    framed = true;
  }
  if (framed) {
    return false;
  }
  if (win.location.pathname.replace(/\/+$/, '') !== `${getBasePath()}/login`) {
    return false;
  }

  const state = new URLSearchParams(win.location.search).get('state');
  return state !== null && readInteractionType(state) === 'popup';
};

// Hands the sign-out response to the waiting tab and closes the popup. If the
// hand-off fails the tab is already signed out locally (MSAL clears its cache
// before opening the popup) and only waits out its timeout, so the popup is
// still closed instead of starting the app.
export const relaySignOutPopupResponse = async (
  win: Window = window,
): Promise<void> => {
  try {
    const { broadcastResponseToMainFrame } =
      await import('@azure/msal-browser/redirect-bridge');
    await broadcastResponseToMainFrame();
  } catch (error) {
    console.debug('Could not return the sign-out response', error);
  }
  try {
    win.close();
  } catch {
    // Nothing more to do; the window was not ours to close.
  }
};
