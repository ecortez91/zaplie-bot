import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import RewardsComponent from './RewardsComponent';
import { RewardNameContext } from './RewardNameContext';

jest.mock('@azure/msal-react', () => ({
  useMsal: () => ({
    instance: { getActiveAccount: () => null },
    accounts: [],
  }),
}));

jest.mock('../services/lnbits/rewards', () => ({
  getNostrRewards: jest.fn(),
}));
jest.mock('../services/lnbits/users', () => ({
  getUsers: jest.fn(),
}));
jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: jest.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rewardName = {
  rewardName: 'sats',
  rewardNameLabel: 'sats',
  setRewardName: jest.fn(),
};

describe('RewardsComponent', () => {
  test('renders the marketplace title without legacy provider branding', () => {
    const view = renderToStaticMarkup(
      <RewardNameContext.Provider value={rewardName}>
        <RewardsComponent />
      </RewardNameContext.Provider>,
    );

    expect(view).toMatch(/>\s*Rewards\s*<\/h1>/);
    expect(view).not.toContain('Provided By');
  });

  test('fails closed when the rewards store is not configured', async () => {
    // REACT_APP_LNBITS_STORE_ID is unset under test, which is the
    // misconfigured-environment path: no silent empty marketplace.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <RewardNameContext.Provider value={rewardName}>
          <RewardsComponent />
        </RewardNameContext.Provider>,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Rewards are not configured for this environment.',
    );
    expect(container.textContent).not.toContain('No rewards are available.');
    expect(container.textContent).not.toContain('Loading rewards');

    // This test uses React's raw createRoot API, which is not auto-wrapped.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => root.unmount());
    container.remove();
  });
});
