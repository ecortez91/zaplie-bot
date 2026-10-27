import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import RewardPolicyPanel, {
  parseSats,
  RewardPolicyPanelProps,
} from './RewardPolicyPanel';
import type { RewardPolicyResponse } from '../apiService';

const OID_A = '11111111-2222-3333-4444-555555555555';
const OID_B = '22222222-2222-3333-4444-555555555555';

const unconfigured = (): RewardPolicyResponse => ({
  rewardAmounts: {},
  maxAmountSats: 10000,
  rewardPolicy: { version: 1, levels: {}, overrides: {}, budget: null },
});

let container: HTMLDivElement;
let root: Root;
let onSave: jest.Mock<Promise<void>, [unknown]>;
let loadPeople: jest.Mock;

const drawPanel = (props: Partial<RewardPolicyPanelProps>) => {
  root.render(
    <RewardPolicyPanel
      isAdmin
      config={unconfigured()}
      loadPeople={loadPeople}
      onSave={onSave}
      {...props}
    />,
  );
};

const mountPanel = async (props: Partial<RewardPolicyPanelProps> = {}) => {
  await act(async () => {
    drawPanel(props);
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const button = (text: string): HTMLButtonElement => {
  const match = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent === text,
  );
  if (!match) {
    throw new Error(`no button "${text}"`);
  }
  return match as HTMLButtonElement;
};

const click = async (text: string) => {
  await act(async () => {
    button(text).click();
  });
};

const type = async (label: string, value: string) => {
  const input = container.querySelector(`[aria-label="${label}"]`) as
    HTMLInputElement | HTMLSelectElement;
  if (!input) {
    throw new Error(`no field "${label}"`);
  }
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
};

const alertText = () =>
  Array.from(container.querySelectorAll('[role="alert"]'))
    .map(node => node.textContent)
    .join(' | ');

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  onSave = jest.fn(async (_patch: unknown) => undefined);
  loadPeople = jest.fn(async () => [
    { personAad: OID_A, displayName: 'Ada' },
    { personAad: OID_B, displayName: 'Ben' },
  ]);
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

describe('parseSats', () => {
  test.each([
    ['21', 21],
    [' 21 ', 21],
    ['0', null],
    ['-5', null],
    ['1.5', null],
    ['1e3', null],
    ['', null],
    ['abc', null],
  ])('%p is %p', (value, expected) => {
    expect(parseSats(value)).toBe(expected);
  });
});

describe('RewardPolicyPanel for a non-admin', () => {
  test('shows the policy read-only and never asks for the people list', async () => {
    await mountPanel({ isAdmin: false });

    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain(
      'Not set: no reward pays until an admin sets a budget.',
    );
    expect(container.textContent).toContain('No level bonuses.');
    expect(loadPeople).not.toHaveBeenCalled();
  });

  test('shows a configured budget and levels', async () => {
    await mountPanel({
      isAdmin: false,
      config: {
        ...unconfigured(),
        rewardPolicy: {
          version: 1,
          levels: {
            githubPrMerged: { labelPrefix: 'reward:', bonuses: { L2: 500 } },
          },
          overrides: { [OID_A]: { githubPrMerged: { baseSats: 1500 } } },
          budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
        },
      },
    });

    expect(container.textContent).toContain(
      '50,000 sats per week (Europe/London)',
    );
    expect(container.textContent).toContain('reward:L2: +500 sats');
    expect(container.textContent).toContain('1 per-person amount set');
  });
});

describe('RewardPolicyPanel budget', () => {
  test('an admin saves a weekly budget', async () => {
    await mountPanel();

    await type('Budget cap in sats', '50000');
    await click('Save budget');

    expect(onSave).toHaveBeenCalledWith({
      budget: { period: 'week', capSats: 50000, timezone: 'Europe/London' },
    });
  });

  test.each([['0'], ['1.5'], ['lots'], ['']])(
    'a cap of %p is blocked before it is sent',
    async cap => {
      await mountPanel();

      await type('Budget cap in sats', cap);
      await click('Save budget');

      expect(onSave).not.toHaveBeenCalled();
      expect(alertText()).toContain('positive whole number');
    },
  );

  test('an unknown time zone is blocked', async () => {
    await mountPanel();

    await type('Budget cap in sats', '100');
    await type('Budget time zone', 'Mars/Base');
    await click('Save budget');

    expect(onSave).not.toHaveBeenCalled();
    expect(alertText()).toContain('IANA time zone');
  });

  test('shows what has been paid this period', async () => {
    await mountPanel({
      spent: {
        period: 'week',
        periodKey: 'week:2026-W44',
        capSats: 50000,
        spentSats: 1200,
      },
    });

    expect(
      container.querySelector('[data-testid="budget-spent"]')?.textContent,
    ).toBe('1,200 of 50,000 sats paid this week');
  });

  test('a server refusal is shown next to the section', async () => {
    onSave.mockRejectedValueOnce(new Error('budget.timezone must be valid'));
    await mountPanel();

    await type('Budget cap in sats', '100');
    await click('Save budget');

    expect(alertText()).toContain('budget.timezone must be valid');
  });
});

describe('RewardPolicyPanel levels', () => {
  test('an admin adds a level bonus', async () => {
    await mountPanel();

    await click('Add level');
    await type('Level 1 bonus', '250');
    await click('Save levels');

    expect(onSave).toHaveBeenCalledWith({
      levels: {
        githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 250 } },
      },
    });
  });

  test('a bonus that pushes the org base over the cap is blocked', async () => {
    await mountPanel({
      config: {
        ...unconfigured(),
        rewardAmounts: { githubPrMergedSats: 9500 },
      },
    });

    await click('Add level');
    await type('Level 1 bonus', '1000');
    await click('Save levels');

    expect(onSave).not.toHaveBeenCalled();
    expect(alertText()).toContain('per-reward cap of 10,000 sats');
  });

  test('a zero bonus and a duplicate level are blocked', async () => {
    await mountPanel();

    await click('Add level');
    await type('Level 1 bonus', '0');
    await click('Save levels');
    expect(alertText()).toContain('positive whole number');

    await type('Level 1 bonus', '5');
    await click('Add level');
    await type('Level 2 name', 'L1');
    await type('Level 2 bonus', '5');
    await click('Save levels');
    expect(alertText()).toContain('listed twice');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('removing every level clears the bonuses for the event', async () => {
    await mountPanel({
      config: {
        ...unconfigured(),
        rewardPolicy: {
          ...unconfigured().rewardPolicy,
          levels: {
            githubPrMerged: { labelPrefix: 'reward:', bonuses: { L1: 5 } },
          },
        },
      },
    });

    await click('Remove');
    await click('Save levels');

    expect(onSave).toHaveBeenCalledWith({ levels: {} });
  });
});

describe('RewardPolicyPanel per-person base', () => {
  test('an admin sets a base for one person and keeps other events untouched', async () => {
    await mountPanel({
      config: {
        ...unconfigured(),
        rewardPolicy: {
          ...unconfigured().rewardPolicy,
          overrides: { [OID_B]: { githubIssueClosed: { baseSats: 9 } } },
        },
      },
    });

    await click('Add person');
    await type('Override 1 person', OID_A);
    await type('Override 1 base', '1500');
    await click('Save overrides');

    expect(onSave).toHaveBeenCalledWith({
      overrides: {
        [OID_B]: { githubIssueClosed: { baseSats: 9 } },
        [OID_A]: { githubPrMerged: { baseSats: 1500 } },
      },
    });
  });

  test('an override without a person or with a bad base is blocked', async () => {
    await mountPanel();

    await click('Add person');
    await type('Override 1 base', '1500');
    await click('Save overrides');
    expect(alertText()).toContain('Choose a person');

    await type('Override 1 person', OID_A);
    await type('Override 1 base', '-1');
    await click('Save overrides');
    expect(alertText()).toContain('Ada must be a positive whole number');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('an override plus the largest bonus over the cap is blocked', async () => {
    await mountPanel({
      config: {
        ...unconfigured(),
        rewardPolicy: {
          ...unconfigured().rewardPolicy,
          levels: {
            githubPrMerged: { labelPrefix: 'reward:', bonuses: { L3: 1000 } },
          },
        },
      },
    });

    await click('Add person');
    await type('Override 1 person', OID_A);
    await type('Override 1 base', '9500');
    await click('Save overrides');

    expect(onSave).not.toHaveBeenCalled();
    expect(alertText()).toContain('per-reward cap');
  });
});

describe('RewardPolicyPanel resync', () => {
  test('a new config from the server replaces unsaved edits', async () => {
    await mountPanel();
    await type('Budget cap in sats', '777');

    await mountPanel({
      config: {
        ...unconfigured(),
        rewardPolicy: {
          ...unconfigured().rewardPolicy,
          budget: { period: 'month', capSats: 900, timezone: 'UTC' },
        },
      },
    });

    expect(
      (
        container.querySelector(
          '[aria-label="Budget cap in sats"]',
        ) as HTMLInputElement
      ).value,
    ).toBe('900');
  });
});
