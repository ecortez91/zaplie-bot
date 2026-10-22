import React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

jest.mock('./App', () => ({
  __esModule: true,
  default: () => <div data-testid="app">Zaplie</div>,
}));

jest.mock('@azure/msal-react', () => ({
  MsalProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// react-router-dom v7's ESM entry does not resolve under CRA's Jest config,
// and the router is irrelevant to the startup sequence under test.
jest.mock('react-router-dom', () => ({
  BrowserRouter: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

jest.mock('./services/msalClient', () => ({
  getMsalInstance: require('@jest/globals').jest.fn(),
}));

const mockBroadcast = jest.fn(async () => undefined);

// A package "exports" subpath that CRA's Jest cannot resolve.
jest.mock(
  '@azure/msal-browser/redirect-bridge',
  () => ({
    broadcastResponseToMainFrame: () => mockBroadcast(),
  }),
  { virtual: true },
);

// An MSAL state value (standard, padded base64 JSON of { id, meta }), as
// msal-common setRequestState builds it with msal-browser's base64Encode, and
// URL-encoded as the query parameter it arrives in.
const msalState = (interactionType: string): string =>
  encodeURIComponent(
    btoa(
      JSON.stringify({
        id: '019a1c3e-1b2c-7d4e-8f90-abcdef123456',
        meta: { interactionType },
      }),
    ),
  );

const getMsalInstance = () =>
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  jest.mocked(require('./services/msalClient').getMsalInstance);

const makeInstance = (overrides: Record<string, unknown> = {}) => ({
  initialize: jest.fn(async () => undefined),
  handleRedirectPromise: jest.fn(async () => null),
  getAllAccounts: jest.fn(() => []),
  getActiveAccount: jest.fn(() => null),
  setActiveAccount: jest.fn(),
  addEventCallback: jest.fn(),
  ...overrides,
});

const makeConsoleErrorSpy = () =>
  jest.fn<void, [message?: unknown, ...rest: unknown[]]>();

describe('index startup sequence', () => {
  let root: HTMLDivElement;
  let consoleError: ReturnType<typeof makeConsoleErrorSpy>;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    // No act() here: jest.resetModules() gives ./index its own React copy, so
    // this file's act() would flush a different renderer's queue.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    jest.resetModules();
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    consoleError = makeConsoleErrorSpy();
    originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    root.remove();
    window.history.replaceState(null, '', '/');
    mockBroadcast.mockClear();
    jest.restoreAllMocks();
  });

  const bootstrap = async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await (require('./index') as { startupComplete: Promise<void> })
      .startupComplete;
    // Let the concurrent root commit before asserting on the DOM.
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  test('renders the app when startup succeeds', async () => {
    getMsalInstance().mockReturnValue(makeInstance());

    await bootstrap();

    expect(root.textContent).toContain('Zaplie');
    expect(root.textContent).not.toContain('could not start');
  });

  test('shows the startup error, naming the missing configuration, when initialize rejects', async () => {
    // Required from the current registry: jest.resetModules() means ./index
    // holds its own copy of the class the instanceof check compares against.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ConfigurationError } =
      require('./services/authConfig') as typeof import('./services/authConfig');
    getMsalInstance().mockImplementation(() => {
      throw new ConfigurationError('REACT_APP_AAD_CLIENT_ID is required.');
    });

    await bootstrap();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Zaplie could not start',
    );
    expect(root.textContent).toContain('REACT_APP_AAD_CLIENT_ID is required.');
    expect(consoleError).toHaveBeenCalledWith(
      'Zaplie startup failed',
      expect.any(Error),
    );
  });

  test('hides the detail of a startup failure that is not a configuration error', async () => {
    getMsalInstance().mockImplementation(() => {
      throw new Error('crypto_nonexistent: internal MSAL detail');
    });

    await bootstrap();

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Zaplie could not start',
    );
    expect(root.textContent).not.toContain('internal MSAL detail');
    expect(consoleError).toHaveBeenCalledWith(
      'Zaplie startup failed',
      expect.any(Error),
    );
  });

  test('still renders the app when the redirect promise rejects', async () => {
    // Declining consent rejects here. AuthEnd has to mount so it can notify
    // Teams; a startup error would leave the Teams popup hanging.
    getMsalInstance().mockReturnValue(
      makeInstance({
        handleRedirectPromise: jest.fn(async () => {
          throw new Error('access_denied');
        }),
      }),
    );

    await bootstrap();

    expect(root.textContent).toContain('Zaplie');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      'Zaplie could not complete the sign-in redirect',
      expect.any(Error),
    );
  });

  test('the Teams sign-out popup relays its response and closes without starting the app', async () => {
    const close = jest.spyOn(window, 'close').mockImplementation(() => {});
    window.history.replaceState(null, '', `/login?state=${msalState('popup')}`);
    getMsalInstance().mockReturnValue(makeInstance());

    await bootstrap();

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    expect(getMsalInstance()).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain('Zaplie');
  });

  test('a full-page sign-out landing on /login?state=... starts the app and ends the sign-out', async () => {
    window.history.replaceState(
      null,
      '',
      `/login?state=${msalState('redirect')}`,
    );
    const instance = makeInstance();
    getMsalInstance().mockReturnValue(instance);

    await bootstrap();

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(instance.handleRedirectPromise).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Zaplie');
  });

  test('the silent sign-in iframe still only relays its response', async () => {
    window.history.replaceState(
      null,
      '',
      `/#code=abc&state=${msalState('silent')}`,
    );
    jest.spyOn(window, 'parent', 'get').mockReturnValue({} as Window);
    getMsalInstance().mockReturnValue(makeInstance());

    await bootstrap();

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(getMsalInstance()).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain('Zaplie');
  });
});
