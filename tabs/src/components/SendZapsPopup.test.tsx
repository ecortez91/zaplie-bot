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
import SendZapsPopup from './SendZapsPopup';
import { RewardNameContext } from './RewardNameContext';

interface PaymentResult {
  payment_hash: string;
}

const mockSendZap = jest.fn<
  Promise<PaymentResult>,
  [string, number, string, string]
>();
const mockGetUsers = jest.fn<Promise<unknown[]>, [unknown]>();
const mockGetUserWallets = jest.fn<Promise<unknown[]>, [string]>();
let mockKeyCounter = 0;

// The account list must be the same object every render: SendZapsPopup keys
// its load effect on `accounts`, so a fresh array each call re-runs the effect
// forever.
jest.mock('@azure/msal-react', () => {
  const accounts = [{ localAccountId: 'caller-oid' }];
  return { useMsal: () => ({ accounts }) };
});

jest.mock('../services/lnbits/payments', () => ({
  sendZap: (...args: [string, number, string, string]) => mockSendZap(...args),
  newIdempotencyKey: () => `generated-key-${(mockKeyCounter += 1)}`,
}));

jest.mock('../services/lnbits/users', () => ({
  getUsers: (options: unknown) => mockGetUsers(options),
}));

jest.mock('../services/lnbits/wallets', () => ({
  getUserWallets: (userId: string) => mockGetUserWallets(userId),
}));

jest.mock('../utils/CacheContext', () => ({
  useCache: () => ({ cache: {}, setCache: () => undefined }),
}));

const USERS = [
  { id: 'user-1', aadObjectId: 'caller-oid', displayName: 'Caller One' },
  { id: 'user-2', aadObjectId: 'other-oid', displayName: 'Recipient Two' },
];

// React tracks the value it set on a controlled node, so assigning `.value`
// directly is ignored. The native setter bypasses that tracker.
const setValue = (element: HTMLElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
};

const byText = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    button => button.textContent?.trim() === text,
  );

describe('SendZapsPopup idempotency key', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mockKeyCounter = 0;
    mockSendZap.mockReset();
    mockGetUsers.mockReset().mockResolvedValue(USERS);
    mockGetUserWallets
      .mockReset()
      .mockImplementation(async (userId: string) =>
        userId === 'user-1'
          ? [{ id: 'w-allow', name: 'Allowance', balance_msat: 100_000_000 }]
          : [{ id: 'w-priv', name: 'Private', balance_msat: 0 }],
      );
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

  const openAndCompose = async (amount: string) => {
    // Not a Testing Library render; the rule misfires on react-dom/client.
    // eslint-disable-next-line testing-library/no-unnecessary-act
    await act(async () => {
      root.render(
        <RewardNameContext.Provider
          value={{ rewardName: 'Sats', setRewardName: jest.fn() }}
        >
          <SendZapsPopup onClose={jest.fn()} />
        </RewardNameContext.Provider>,
      );
    });
    await flush();

    const select = container.querySelector('select');
    await act(async () => {
      setValue(select as HTMLElement, 'user-2');
    });
    await flush();

    const input = container.querySelector('input[type="number"]');
    await act(async () => {
      setValue(input as HTMLElement, amount);
    });
    await flush();
  };

  const send = async () => {
    const button = byText(container, 'Send');
    await click(button as Element);
  };

  const keysSent = () => mockSendZap.mock.calls.map(call => call[3]);

  test('replays the same key when the user retries after a timeout', async () => {
    mockSendZap.mockRejectedValueOnce(new Error('Request timed out'));
    await openAndCompose('21');
    await send();

    // The gateway can still be paying when the client gives up, so the retry
    // has to carry the first key or the second attempt pays again.
    expect(keysSent()).toEqual(['generated-key-1']);

    const tryAgain = byText(container, 'Try Again');
    expect(tryAgain).toBeDefined();
    await click(tryAgain as Element);

    mockSendZap.mockResolvedValueOnce({ payment_hash: 'hash-1' });
    await send();

    expect(keysSent()).toEqual(['generated-key-1', 'generated-key-1']);
  });

  test('offers Close, not Try Again, when the gateway says do not retry', async () => {
    mockSendZap.mockRejectedValueOnce(
      new Error(
        'This zap may have been paid but could not be recorded. Do not retry: ' +
          'contact support to confirm whether it went through.',
      ),
    );
    await openAndCompose('21');
    await send();

    // A retry here is the second payment the idempotency layer exists to stop.
    expect(byText(container, 'Try Again')).toBeUndefined();
    const close = byText(container, 'Close');
    expect(close).toBeDefined();

    await click(close as Element);
    expect(mockSendZap).toHaveBeenCalledTimes(1);
  });

  test('mints a new key once the zap details change', async () => {
    mockSendZap.mockRejectedValueOnce(new Error('Request timed out'));
    await openAndCompose('21');
    await send();

    await click(byText(container, 'Try Again') as Element);

    // A different amount is a different zap; reusing the key would be refused
    // by the gateway with "already used for another zap".
    const input = container.querySelector('input[type="number"]');
    await act(async () => {
      setValue(input as HTMLElement, '22');
    });
    await flush();

    mockSendZap.mockResolvedValueOnce({ payment_hash: 'hash-2' });
    await send();

    expect(keysSent()).toEqual(['generated-key-1', 'generated-key-2']);
    expect(mockSendZap.mock.calls[1][1]).toBe(22);
  });
});
