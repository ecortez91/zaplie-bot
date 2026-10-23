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
import { useAccount, useIsAuthenticated, useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useTeamsAuth } from '../hooks/useTeamsAuth';
import HeaderComponent from './HeaderComponent';

jest.mock('@azure/msal-react', () => ({
  useMsal: require('@jest/globals').jest.fn(),
  useAccount: require('@jest/globals').jest.fn(),
  useIsAuthenticated: require('@jest/globals').jest.fn(),
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config;
// the header only renders a Link to the feed.
jest.mock('react-router-dom', () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

jest.mock('../hooks/useTeamsAuth', () => ({
  useTeamsAuth: require('@jest/globals').jest.fn(),
}));

jest.mock('./NavigationLinks', () => () => null);

const mockUseMsal = jest.mocked(useMsal);
const mockUseAccount = jest.mocked(useAccount);
const mockUseIsAuthenticated = jest.mocked(useIsAuthenticated);
const mockUseTeamsAuth = jest.mocked(useTeamsAuth);

const account = { name: 'Alice Example', username: 'alice@example.test' };

type State = {
  signedIn: boolean;
  inProgress?: InteractionStatus;
  isInTeams?: boolean;
};

describe('HeaderComponent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const mountHeader = () => {
    root.render(<HeaderComponent />);
  };

  const renderHeader = async ({
    signedIn,
    inProgress = InteractionStatus.None,
    isInTeams = false,
  }: State) => {
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: signedIn ? [account] : [],
      inProgress,
    } as unknown as ReturnType<typeof useMsal>);
    mockUseAccount.mockReturnValue(
      (signedIn ? account : null) as ReturnType<typeof useAccount>,
    );
    mockUseIsAuthenticated.mockReturnValue(signedIn);
    mockUseTeamsAuth.mockReturnValue({
      isInTeams,
      isTeamsInitializing: false,
      handleLogout: jest.fn(async () => undefined),
      isLoggingOut: false,
    });
    await act(async () => {
      mountHeader();
    });
  };

  const leftSection = () => container.querySelector('.leftSection');
  const siteLink = () =>
    container.querySelector<HTMLAnchorElement>('a[href="https://getzapl.ie"]');

  test('signed in, the link back to the website sits beside the wordmark', async () => {
    await renderHeader({ signedIn: true });

    const left = leftSection();
    expect(left?.querySelector('a[href="/feed"]')?.textContent).toBe('Zaplie');
    expect(left?.contains(siteLink())).toBe(true);
    expect(siteLink()?.textContent).toContain('Back to getzapl.ie');
  });

  test('signed out, the header still links back to the website', async () => {
    await renderHeader({ signedIn: false });

    expect(leftSection()?.contains(siteLink())).toBe(true);
  });

  test('while signing in, the header still links back to the website', async () => {
    await renderHeader({
      signedIn: false,
      inProgress: InteractionStatus.HandleRedirect,
    });

    expect(leftSection()?.contains(siteLink())).toBe(true);
  });

  test('inside Teams renders no header and no link', async () => {
    await renderHeader({ signedIn: true, isInTeams: true });

    expect(container.querySelector('header')).toBeNull();
    expect(siteLink()).toBeNull();
  });
});
