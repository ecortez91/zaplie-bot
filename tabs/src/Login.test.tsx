import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import * as microsoftTeams from '@microsoft/teams-js';
import { useTeamsAuth } from './hooks/useTeamsAuth';
import { clearSilentSignInGuard } from './services/silentSignIn';
import { Login } from './Login';

// Signed out: only the unauthenticated view renders.
jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
  AuthenticatedTemplate: () => null,
  UnauthenticatedTemplate: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config.
jest.mock('react-router-dom', () => ({
  useNavigate: () => require('@jest/globals').jest.fn(),
}));

jest.mock('@microsoft/teams-js', () => ({
  app: {
    getContext: require('@jest/globals').jest.fn(),
  },
}));

jest.mock('./hooks/useTeamsAuth', () => ({
  useTeamsAuth: require('@jest/globals').jest.fn(),
}));

jest.mock('./services/authConfig', () => ({
  loginRequest: { scopes: ['User.Read'] },
}));

jest.mock('./components/SignInSignOutButton', () => () => (
  <button type="button" data-testid="sign-in-button">
    Sign In
  </button>
));

const mockUseMsal = jest.mocked(useMsal);
const mockUseTeamsAuth = jest.mocked(useTeamsAuth);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);
const mockSsoSilent = jest.fn<Promise<unknown>, [unknown]>();

const signInButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[data-testid="sign-in-button"]');

describe('Login in a Teams tab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    sessionStorage.clear();
    clearSilentSignInGuard();
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    mockUseMsal.mockReturnValue({
      instance: { ssoSilent: mockSsoSilent, setActiveAccount: jest.fn() },
      accounts: [],
      inProgress: InteractionStatus.None,
    } as unknown as ReturnType<typeof useMsal>);
    mockUseTeamsAuth.mockReturnValue({
      isInTeams: true,
      isTeamsInitializing: false,
      handleLogout: jest.fn(async () => undefined),
      isLoggingOut: false,
    });
    mockGetContext.mockResolvedValue({
      user: { loginHint: 'alice@example.test' },
    } as unknown as Awaited<ReturnType<typeof microsoftTeams.app.getContext>>);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
  });

  const mountLogin = () => {
    root.render(<Login />);
  };

  const renderLogin = async () => {
    await act(async () => {
      mountLogin();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  test('hides the Sign In button while signing in silently, and shows it after a failure', async () => {
    let fail: (() => void) | undefined;
    mockSsoSilent.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('login_required'));
        }),
    );

    await renderLogin();

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Signing you in…',
    );
    expect(signInButton(container)).toBeNull();

    await act(async () => {
      fail?.();
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(signInButton(container)?.textContent).toBe('Sign In');
  });

  test('outside Teams shows the Sign In button straight away', async () => {
    mockUseTeamsAuth.mockReturnValue({
      isInTeams: false,
      isTeamsInitializing: false,
      handleLogout: jest.fn(async () => undefined),
      isLoggingOut: false,
    });

    await renderLogin();

    expect(mockSsoSilent).not.toHaveBeenCalled();
    expect(signInButton(container)?.textContent).toBe('Sign In');
  });
});
