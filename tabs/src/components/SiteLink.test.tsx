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
import { useTeamsAuth } from '../hooks/useTeamsAuth';
import SiteLink from './SiteLink';

jest.mock('../hooks/useTeamsAuth', () => ({
  useTeamsAuth: require('@jest/globals').jest.fn(),
}));

const mockUseTeamsAuth = jest.mocked(useTeamsAuth);

const teamsState = (isInTeams: boolean, isTeamsInitializing: boolean) => ({
  isInTeams,
  isTeamsInitializing,
  handleLogout: jest.fn(async () => undefined),
  isLoggingOut: false,
});

describe('SiteLink', () => {
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

  const mountSiteLink = (element: React.ReactElement) => {
    root.render(element);
  };

  const showSiteLink = async (element: React.ReactElement = <SiteLink />) => {
    await act(async () => {
      mountSiteLink(element);
    });
  };

  const siteLink = () => container.querySelector('a');

  test('in a browser links back to the website in the same tab', async () => {
    mockUseTeamsAuth.mockReturnValue(teamsState(false, false));

    await showSiteLink();

    const anchor = siteLink();
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://getzapl.ie');
    expect(anchor?.hasAttribute('target')).toBe(false);
    expect(anchor?.textContent).toContain('Back to getzapl.ie');
    // The arrow is decoration; the accessible name is the text.
    expect(anchor?.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      '←',
    );
  });

  test('uses the dark-background style on the sign-in page', async () => {
    mockUseTeamsAuth.mockReturnValue(teamsState(false, false));

    await showSiteLink(<SiteLink variant="onDark" />);

    expect(siteLink()?.className).toContain('onDark');
  });

  test('renders nothing inside Teams', async () => {
    mockUseTeamsAuth.mockReturnValue(teamsState(true, false));

    await showSiteLink();

    expect(siteLink()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  test('renders nothing while Teams detection is still running', async () => {
    mockUseTeamsAuth.mockReturnValue(teamsState(false, true));

    await showSiteLink();

    expect(siteLink()).toBeNull();
    expect(container.innerHTML).toBe('');
  });
});
