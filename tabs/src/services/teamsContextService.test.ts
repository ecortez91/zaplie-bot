import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import * as microsoftTeams from '@microsoft/teams-js';
import { detectTeamsContext } from './teamsContextService';
import { TEAMS_CONTEXT_TIMEOUT_MS } from './teamsTimeout';

jest.mock('@microsoft/teams-js', () => ({
  app: {
    initialize: require('@jest/globals').jest.fn(),
    getContext: require('@jest/globals').jest.fn(),
    isInitialized: require('@jest/globals').jest.fn(),
  },
}));

const mockIsInitialized = jest.mocked(microsoftTeams.app.isInitialized);
const mockInitialize = jest.mocked(microsoftTeams.app.initialize);
const mockGetContext = jest.mocked(microsoftTeams.app.getContext);

describe('detectTeamsContext', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a host that answers getContext is Teams', async () => {
    mockIsInitialized.mockReturnValue(true);
    mockGetContext.mockResolvedValue(
      {} as Awaited<ReturnType<typeof microsoftTeams.app.getContext>>,
    );

    await expect(detectTeamsContext()).resolves.toBe(true);
  });

  test('a plain browser, where initialize rejects, is not Teams', async () => {
    mockIsInitialized.mockReturnValue(false);
    mockInitialize.mockRejectedValue(
      new Error('Initialization Failed. No Parent window found.'),
    );

    await expect(detectTeamsContext()).resolves.toBe(false);
    expect(mockGetContext).not.toHaveBeenCalled();
  });

  test('a Teams host that never answers getContext counts as not-in-Teams after the timeout', async () => {
    jest.useFakeTimers();
    mockIsInitialized.mockReturnValue(true);
    mockGetContext.mockImplementation(() => new Promise(() => undefined));

    const detection = detectTeamsContext();
    // Let detectTeamsContext reach the getContext call before time moves on.
    await Promise.resolve();
    jest.advanceTimersByTime(TEAMS_CONTEXT_TIMEOUT_MS);

    await expect(detection).resolves.toBe(false);
  });
});
