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
import AutomationsComponent from './AutomationsComponent';
import type { AutomationsStats } from '../services/automationsStatsService';
import type { WebhookKey } from '../services/webhookKeysService';

interface MsalContextStub {
  instance: Record<string, unknown>;
  accounts: { homeAccountId: string }[];
}

const mockUseMsal = jest.fn<MsalContextStub, []>();
const mockAcquireIdToken = jest.fn<Promise<string>, []>();
const mockToastError = jest.fn<void, unknown[]>();
const mockToastSuccess = jest.fn<void, unknown[]>();
const mockGetGithubConnection = jest.fn<
  Promise<{ connected: boolean }>,
  [string]
>();
const mockGetAutomationsStats = jest.fn<Promise<AutomationsStats>, [string]>();
const mockGetWebhookKeys = jest.fn<Promise<WebhookKey[]>, [string]>();

jest.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
}));

jest.mock('../services/adminRole', () => ({
  acquireIdToken: () => mockAcquireIdToken(),
  isZaplieAdmin: () => true,
}));

jest.mock('../apiService', () => ({
  getAutomations: () => Promise.resolve({ repos: [] }),
  updateAutomations: () => Promise.resolve({ repos: [] }),
  getRewardAmounts: () => Promise.resolve({ rewardAmounts: {} }),
  updateRewardAmounts: () => Promise.resolve({ rewardAmounts: {} }),
}));

jest.mock('../services/connectionsService', () => ({
  getGithubConnection: (idToken: string) => mockGetGithubConnection(idToken),
  getGithubInstallUrl: () => Promise.resolve('https://github.test/install'),
}));

jest.mock('../services/automationsStatsService', () => ({
  getAutomationsStats: (idToken: string) => mockGetAutomationsStats(idToken),
}));

jest.mock('../services/webhookKeysService', () => ({
  getWebhookKeys: (idToken: string) => mockGetWebhookKeys(idToken),
  createWebhookKey: () => Promise.resolve({ key: 'zpl_x', id: 'id' }),
  revokeWebhookKey: () => Promise.resolve(),
}));

jest.mock('react-toastify', () => ({
  ToastContainer: () => null,
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const webhookKey: WebhookKey = {
  id: '6f0b1e2c-6a4d-4c1a-9a0d-0b6a9c2f1e33',
  label: 'Treasury payout runner',
  last4: 'a1b2',
  createdAt: '2026-08-01T10:00:00.000Z',
  revokedAt: null,
};

const emptyStats: AutomationsStats = {
  paidSatsThisMonth: 0,
  paymentsThisMonth: 0,
  runsByEventType: {},
  engagementByAudience: { teammates: [], copilots: [], customers: [] },
  recentPayments: [],
};

let container: HTMLDivElement;
let root: Root;

function mountAutomations(): void {
  root.render(<AutomationsComponent />);
}

const renderAutomations = async () => {
  await act(async () => {
    mountAutomations();
  });
  // Let the two load effects settle.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('AutomationsComponent panel independence', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    jest.clearAllMocks();
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: [{ homeAccountId: 'account-1' }],
    });
    mockAcquireIdToken.mockResolvedValue('id-token');
    mockGetGithubConnection.mockResolvedValue({ connected: true });
    mockGetWebhookKeys.mockResolvedValue([webhookKey]);
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

  test('renders the other panels while stats is still pending', async () => {
    // Never resolves: under Promise.all/allSettled the banner and the key list
    // would still be waiting here, so this is what proves they are independent
    // rather than merely tolerant of a rejection in the same microtask.
    mockGetAutomationsStats.mockReturnValue(new Promise(() => undefined));

    await renderAutomations();

    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);
    // Stats itself is still loading, so no error state yet.
    expect(container.textContent).toContain('Loading recipient activity');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test('shows a stats-only error and keeps the other panels when stats rejects', async () => {
    mockGetAutomationsStats.mockRejectedValue(
      new Error('Automations stats response is malformed.'),
    );

    await renderAutomations();

    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);
    // Stats gets its own, non-blocking error state.
    expect(container.textContent).toContain(
      'Recipient activity is unavailable right now.',
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // No generic connection toast: the connection call succeeded.
    expect(mockToastError).not.toHaveBeenCalledWith(
      'Could not load connection status.',
    );
  });

  test('still renders API keys when the GitHub connection rejects', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    mockGetGithubConnection.mockRejectedValue(new Error('502 from GitHub'));

    await renderAutomations();

    expect(container.textContent).toContain(webhookKey.label);
    expect(mockToastError).toHaveBeenCalledWith(
      'Could not load connection status.',
    );
    // The previous account's banner must not survive a failed reload.
    expect(container.textContent).toContain('Not connected yet');
  });

  test('drops the previous key labels when the key request rejects', async () => {
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    mockGetWebhookKeys.mockRejectedValue(new Error('403'));

    await renderAutomations();

    expect(container.textContent).not.toContain(webhookKey.label);
    expect(mockToastError).toHaveBeenCalledWith('Could not load the API keys.');
  });

  test('clears the previous account state when a reload for a new account fails', async () => {
    // Load one account successfully first, so the assertions below are about
    // state actually being cleared rather than never having been set.
    mockGetAutomationsStats.mockResolvedValue(emptyStats);
    await renderAutomations();
    expect(container.textContent).toContain('App installed');
    expect(container.textContent).toContain(webhookKey.label);

    // Switch account and fail every request for the new one.
    mockUseMsal.mockReturnValue({
      instance: {},
      accounts: [{ homeAccountId: 'account-2' }],
    });
    mockGetGithubConnection.mockRejectedValue(new Error('403'));
    mockGetAutomationsStats.mockRejectedValue(new Error('403'));
    mockGetWebhookKeys.mockRejectedValue(new Error('403'));

    await renderAutomations();

    expect(container.textContent).toContain('Not connected yet');
    expect(container.textContent).not.toContain(webhookKey.label);
    expect(container.textContent).toContain(
      'Recipient activity is unavailable right now.',
    );
  });
});
