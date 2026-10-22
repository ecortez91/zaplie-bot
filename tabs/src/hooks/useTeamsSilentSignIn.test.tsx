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
import { useTeamsAuth } from './useTeamsAuth';
import {
  TEAMS_CONTEXT_TIMEOUT_MS,
  useTeamsSilentSignIn,
} from './useTeamsSilentSignIn';
import {
  SILENT_SIGN_IN_GUARD_KEY,
  clearSilentSignInGuard,
} from '../services/silentSignIn';

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
}));

jest.mock('@microsoft/teams-js', () => ({
  app: {
    getContext: require('@jest/globals').jest.fn(),
  },
}));

jest.mock('./useTeamsAuth', () => ({
  useTeamsAuth: require('@jest/globals').jest.fn(),
}));

jest.mock('../services/authConfig', () => ({
  loginRequest: { scopes: ['User.Read'] },
}));

const mockUseMsal = jest.mocked(useMsal);
const mockUseTeamsAuth = jest.mocked(useTeamsAuth);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);
const mockSsoSilent = jest.fn<Promise<unknown>, [unknown]>();
const mockSetActiveAccount = jest.fn<void, [unknown]>();

const teamsContext = (user: Record<string, string> | undefined) =>
  ({ user }) as unknown as Awaited<
    ReturnType<typeof microsoftTeams.app.getContext>
  >;

const Probe = () => {
  const { attempting } = useTeamsSilentSignIn();
  return <p>{attempting ? 'attempting' : 'idle'}</p>;
};

describe('useTeamsSilentSignIn', () => {
  let container: HTMLDivElement;
  let root: Root;

  const setMsal = (accounts: unknown[] = []) => {
    mockUseMsal.mockReturnValue({
      instance: {
        ssoSilent: mockSsoSilent,
        setActiveAccount: mockSetActiveAccount,
      },
      accounts,
      inProgress: InteractionStatus.None,
    } as unknown as ReturnType<typeof useMsal>);
  };

  const setTeams = (isInTeams: boolean) => {
    mockUseTeamsAuth.mockReturnValue({
      isInTeams,
      isTeamsInitializing: false,
      handleLogout: jest.fn(async () => undefined),
      isLoggingOut: false,
    });
  };

  const mountProbe = () => {
    root.render(<Probe />);
  };

  const renderProbe = async () => {
    await act(async () => {
      mountProbe();
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    sessionStorage.clear();
    clearSilentSignInGuard();
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    setMsal();
    setTeams(true);
    mockGetContext.mockResolvedValue(
      teamsContext({
        loginHint: 'alice@example.test',
        userPrincipalName: 'alice.upn@example.test',
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
    jest.restoreAllMocks();
  });

  test('does nothing outside Teams', async () => {
    setTeams(false);

    await renderProbe();

    expect(mockSsoSilent).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBeNull();
    expect(container.textContent).toBe('idle');
  });

  test('does nothing when an account is already signed in', async () => {
    setMsal([{ homeAccountId: 'account-1' }]);

    await renderProbe();

    expect(mockSsoSilent).not.toHaveBeenCalled();
  });

  test('in Teams, signs in silently once with the Teams login hint', async () => {
    const account = { homeAccountId: 'account-1' };
    mockSsoSilent.mockResolvedValue({ account });

    await renderProbe();

    expect(mockSsoSilent).toHaveBeenCalledTimes(1);
    expect(mockSsoSilent).toHaveBeenCalledWith({
      scopes: ['User.Read'],
      loginHint: 'alice@example.test',
    });
    expect(mockSetActiveAccount).toHaveBeenCalledWith(account);
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBe('1');
  });

  test('falls back to the user principal name when Teams gives no login hint', async () => {
    mockGetContext.mockResolvedValue(
      teamsContext({ userPrincipalName: 'alice.upn@example.test' }),
    );
    mockSsoSilent.mockResolvedValue({ account: { homeAccountId: 'a' } });

    await renderProbe();

    expect(mockSsoSilent).toHaveBeenCalledWith({
      scopes: ['User.Read'],
      loginHint: 'alice.upn@example.test',
    });
  });

  test('reports attempting while the silent sign-in is in flight', async () => {
    let finish: (() => void) | undefined;
    mockSsoSilent.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          finish = () => reject(new Error('login_required'));
        }),
    );

    await renderProbe();
    expect(container.textContent).toBe('attempting');

    await act(async () => {
      finish?.();
    });
    expect(container.textContent).toBe('idle');
  });

  test('a failure is quiet, sets the guard and is not retried on re-render or remount', async () => {
    mockSsoSilent.mockRejectedValue(new Error('login_required'));

    await renderProbe();
    await renderProbe();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderProbe();

    expect(mockSsoSilent).toHaveBeenCalledTimes(1);
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalledWith(
      'Silent Teams sign-in did not complete; showing the Sign In button.',
      expect.any(Error),
    );
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBe('1');
    expect(container.textContent).toBe('idle');
  });

  test('a Teams context failure is quiet too', async () => {
    mockGetContext.mockRejectedValue(new Error('Teams unavailable'));

    await renderProbe();

    expect(mockSsoSilent).not.toHaveBeenCalled();
    expect(container.textContent).toBe('idle');
  });

  test('shows the Sign In button when Teams never answers, and ignores a late context', async () => {
    jest.useFakeTimers();
    let answer:
      ((context: ReturnType<typeof teamsContext>) => void) | undefined;
    mockGetContext.mockImplementation(
      () =>
        new Promise(resolve => {
          answer = resolve;
        }),
    );

    await act(async () => {
      mountProbe();
    });
    expect(container.textContent).toBe('attempting');

    await act(async () => {
      jest.advanceTimersByTime(TEAMS_CONTEXT_TIMEOUT_MS);
    });
    expect(container.textContent).toBe('idle');
    expect(mockSsoSilent).not.toHaveBeenCalled();
    expect(console.debug).toHaveBeenCalledWith(
      'Silent Teams sign-in did not complete; showing the Sign In button.',
      expect.any(Error),
    );

    await act(async () => {
      answer?.(teamsContext({ loginHint: 'late@example.test' }));
    });
    expect(mockSsoSilent).not.toHaveBeenCalled();
    expect(mockSetActiveAccount).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SILENT_SIGN_IN_GUARD_KEY)).toBe('1');
  });

  test('tries again once the guard is cleared (after a sign-out)', async () => {
    mockSsoSilent.mockRejectedValue(new Error('login_required'));
    await renderProbe();

    clearSilentSignInGuard();
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderProbe();

    expect(mockSsoSilent).toHaveBeenCalledTimes(2);
  });
});
