import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import AllowancePanel, {
  AllowancePanelProps,
  buildAllowancePatch,
} from './AllowancePanel';
import type {
  AllowancePolicy,
  AllowanceStatus,
  AllowanceSyncResult,
} from '../apiService';

const defaultPolicy = (): AllowancePolicy => ({
  version: 1,
  enabled: false,
  amountSats: null,
  period: null,
  anchorWeekday: null,
  anchorDay: null,
  anchorTime: null,
  timezone: null,
  memo: '',
  payLink: { minSats: null, maxSats: null, commentChars: 0 },
  overwriteDrift: false,
  excludedOids: [],
  updatedAt: null,
  updatedBy: null,
});

const status = (policy: Partial<AllowancePolicy> = {}): AllowanceStatus => ({
  policy: { ...defaultPolicy(), ...policy },
  maxAmountSats: 100000,
  fund: {
    configured: true,
    wallets: [{ id: 'fund-1', name: 'Fund', balanceSats: 900000 }],
    health: {
      healthy: true,
      schedulerOk: true,
      lastCompleted: 1,
      overdue: 0,
      pending: 0,
    },
  },
  lastRun: null,
  lastAdminApply: null,
  running: false,
  timer: {
    enabled: true,
    disabled: false,
    invalid: false,
    intervalMinutes: 360,
  },
});

// Test values only.
const preview = (
  overrides: Partial<AllowanceSyncResult> = {},
): AllowanceSyncResult => ({
  mode: 'dry',
  at: '2026-10-28T12:00:00.000Z',
  summary: {
    policyEnabled: true,
    fundConfigured: true,
    people: 2,
    paylinkCreates: 2,
    paylinkUpdates: 0,
    creates: 2,
    updates: 0,
    recreates: 0,
    deletes: 0,
    noop: 0,
    drift: 0,
    paused: 0,
    deferred: 0,
    skipped: 0,
    changes: 4,
    amountSats: 25000,
    totalPerPeriodSats: 50000,
    fundBalanceSats: 900000,
    nextStart: '2026-10-30T09:00:00.000Z',
  },
  warnings: [],
  blockers: [],
  actions: [
    {
      kind: 'create',
      oid: 'aaaaaaaa-0000-4000-8000-000000000001',
      displayName: 'Ada',
      reason: null,
      amountSats: 25000,
      lightningAddress: 'zaplie-aaaaaaaa0000@bank.example.test',
    },
  ],
  ...overrides,
});

let container: HTMLDivElement;
let root: Root;
let onSave: jest.Mock;
let onPreview: jest.Mock;
let onApply: jest.Mock;

const drawPanel = (props: Partial<AllowancePanelProps>) => {
  root.render(
    <AllowancePanel
      isAdmin
      status={status()}
      onSave={onSave}
      onPreview={onPreview}
      onApply={onApply}
      {...props}
    />,
  );
};

const mount = async (props: Partial<AllowancePanelProps> = {}) => {
  await act(async () => {
    drawPanel(props);
  });
};

const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find(candidate =>
    candidate.textContent?.startsWith(text),
  ) as HTMLButtonElement | undefined;

const click = async (text: string) => {
  const button = buttonNamed(text);
  if (!button) throw new Error(`no button "${text}"`);
  await act(async () => {
    button.click();
  });
};

const control = (testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`) as
    HTMLInputElement | HTMLSelectElement | null;

// The accessible name a labelled control gets: its own aria-label if it has
// one, else the text of the <label> that wraps it.
const nameOf = (element: Element | null): string =>
  element?.getAttribute('aria-label') ??
  element?.closest('label')?.textContent ??
  '';

const setValue = async (testId: string, value: string) => {
  const input = control(testId);
  if (!input) throw new Error(`no field "${testId}"`);
  const proto =
    input instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
};

const toggle = async (testId: string) => {
  const input = control(testId);
  if (!input) throw new Error(`no checkbox "${testId}"`);
  await act(async () => {
    input.click();
  });
};

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  onSave = jest.fn().mockResolvedValue(undefined);
  onPreview = jest.fn().mockResolvedValue(preview());
  onApply = jest.fn().mockResolvedValue({
    ...preview(),
    mode: 'apply',
    result: {
      mode: 'apply',
      at: '2026-10-28T12:00:00.000Z',
      by: 'admin',
      created: 2,
      updated: 0,
      deleted: 0,
      payLinks: 2,
      drift: 0,
      errors: 0,
      aborted: null,
      totalPerPeriodSats: 50000,
    },
  });
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

describe('AllowancePanel', () => {
  test('a non-admin sees the policy, Fund and health read-only, with no sync controls', async () => {
    await mount({
      isAdmin: false,
      status: status({
        enabled: true,
        amountSats: 25000,
        period: 'weekly',
        anchorWeekday: 5,
        anchorTime: '09:00',
        timezone: 'Europe/London',
      }),
    });
    expect(
      container.querySelector('[data-testid="allowance-policy"]')?.textContent,
    ).toBe('25,000 sats every Friday at 09:00 (Europe/London)');
    expect(container.querySelector('input')).toBeNull();
    expect(buttonNamed('Preview sync')).toBeUndefined();
    expect(buttonNamed('Save policy')).toBeUndefined();
    expect(container.textContent).toContain('Fund: 900,000 sats');
    expect(
      container.querySelector('[data-testid="allowance-health"]')?.textContent,
    ).toBe('Healthy');
  });

  test('the default policy reads as off', async () => {
    await mount({ isAdmin: false });
    expect(container.textContent).toContain(
      'Off: no allowance is created or paid.',
    );
  });

  test('apply only appears after a preview, and echoes the previewed total', async () => {
    await mount();
    expect(buttonNamed('Apply')).toBeUndefined();

    await click('Preview sync');
    expect(onPreview).toHaveBeenCalledWith({ overwriteDrift: false });
    expect(
      container.querySelector('[data-testid="allowance-preview"]')?.textContent,
    ).toContain('50,000 sats');
    expect(container.textContent).toContain('Ada');

    await click('Apply 4 changes');
    expect(onApply).toHaveBeenCalledWith({
      confirmTotalSats: 50000,
      overwriteDrift: false,
      allowUnderfunded: false,
      allowMassDelete: false,
    });
    expect(
      container.querySelector('[data-testid="allowance-applied"]')?.textContent,
    ).toContain('created 2');
    // The preview is spent: applying again needs a new one.
    expect(buttonNamed('Apply')).toBeUndefined();
  });

  test('a blocker disables apply; underfunded needs an explicit tick', async () => {
    onPreview.mockResolvedValueOnce(
      preview({
        blockers: [
          {
            code: 'underfunded',
            overridable: true,
            message: 'Fund wallet Fund holds 1 sats, less than one period',
          },
        ],
      }),
    );
    await mount();
    await click('Preview sync');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(true);
    await toggle('sync-allow-underfunded');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(false);
    await click('Apply 4 changes');
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnderfunded: true }),
    );

    onPreview.mockResolvedValueOnce(
      preview({
        blockers: [{ code: 'too-many-people', message: 'too many' }],
      }),
    );
    await click('Preview sync');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(true);
  });

  test('a mass delete of leavers needs its own tick; an incomplete user list cannot be overridden', async () => {
    onPreview.mockResolvedValueOnce(
      preview({
        blockers: [
          {
            code: 'mass-delete',
            message: '9 leaver schedules would be deleted, more than 5',
          },
        ],
      }),
    );
    await mount();
    await click('Preview sync');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(true);
    await toggle('sync-allow-mass-delete');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(false);
    await click('Apply 4 changes');
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        allowMassDelete: true,
        allowUnderfunded: false,
      }),
    );

    onPreview.mockResolvedValueOnce(
      preview({
        blockers: [
          {
            code: 'people-incomplete',
            message: 'LNbits returned fewer users than it announced',
          },
        ],
      }),
    );
    await click('Preview sync');
    expect(buttonNamed('Apply 4 changes')?.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="sync-allow-mass-delete"]'),
    ).toBeNull();
  });

  test('nothing to change means nothing to apply', async () => {
    onPreview.mockResolvedValueOnce(
      preview({ summary: { ...preview().summary, changes: 0 } }),
    );
    await mount();
    await click('Preview sync');
    expect(buttonNamed('Apply 0 changes')?.disabled).toBe(true);
  });

  test('changing the overwrite option discards the preview', async () => {
    await mount();
    await click('Preview sync');
    expect(buttonNamed('Apply 4 changes')).toBeDefined();
    await toggle('sync-overwrite-drift');
    expect(buttonNamed('Apply')).toBeUndefined();
    await click('Preview sync');
    expect(onPreview).toHaveBeenLastCalledWith({ overwriteDrift: true });
  });

  test('a refused apply shows the server message and needs a new preview', async () => {
    onApply.mockRejectedValueOnce(
      new Error('confirmTotalSats does not match the plan'),
    );
    await mount();
    await click('Preview sync');
    await click('Apply 4 changes');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'does not match',
    );
    expect(buttonNamed('Apply')).toBeUndefined();
  });

  test('saving validates first: turning it on needs the whole schedule', async () => {
    await mount();
    await toggle('allowance-enabled');
    await setValue('allowance-amount', '25000');
    await click('Save policy');
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'set the weekday, the time, the time zone',
    );

    await setValue('allowance-weekday', '5');
    await setValue('allowance-time', '09:00');
    await setValue('allowance-timezone', 'Europe/London');
    await setValue('allowance-memo', 'Weekly allowance');
    await click('Save policy');
    expect(onSave).toHaveBeenCalledWith({
      enabled: true,
      amountSats: 25000,
      period: 'weekly',
      anchorWeekday: 5,
      anchorDay: null,
      anchorTime: '09:00',
      timezone: 'Europe/London',
      memo: 'Weekly allowance',
      payLink: { minSats: null, maxSats: null, commentChars: 0 },
    });
  });

  test('every control is named by its visible label text (WCAG 2.5.3)', async () => {
    onPreview.mockResolvedValueOnce(
      preview({
        blockers: [
          {
            code: 'underfunded',
            overridable: true,
            message: 'Fund wallet Fund holds 1 sats, less than one period',
          },
          {
            code: 'mass-delete',
            message: '9 leaver schedules would be deleted, more than 5',
          },
        ],
      }),
    );
    await mount();
    const expectName = (testId: string, text: string) => {
      const element = control(testId);
      if (!element) throw new Error(`no control "${testId}"`);
      expect(nameOf(element)).toContain(text);
    };
    expectName('allowance-enabled', 'Allowances off');
    expectName('allowance-amount', 'Amount (sats)');
    expectName('allowance-period', 'Period');
    expectName('allowance-weekday', 'Day');
    expectName('allowance-time', 'Time (HH:mm)');
    expectName('allowance-timezone', 'Time zone');
    expectName('allowance-memo', 'Memo');
    expectName('allowance-min', 'Pay link min (sats)');
    expectName('allowance-max', 'Pay link max (sats)');
    expectName('allowance-comment-chars', 'Comment characters');
    expectName('sync-overwrite-drift', 'Overwrite schedules edited by hand');

    await toggle('allowance-enabled');
    expectName('allowance-enabled', 'Allowances on');
    await setValue('allowance-period', 'monthly');
    expectName('allowance-day-of-month', 'Day of month');

    await click('Preview sync');
    expectName(
      'sync-allow-underfunded',
      'Apply although the Fund holds less than one period',
    );
    expectName(
      'sync-allow-mass-delete',
      'These people have left LNbits: delete their schedules',
    );
    expect(
      container.querySelectorAll('input[aria-label], select[aria-label]'),
    ).toHaveLength(0);
  });

  test('buildAllowancePatch refuses the hidden memo, an over-cap amount and a bad range', () => {
    const draft = {
      enabled: true,
      amount: '25000',
      period: 'weekly' as const,
      anchorWeekday: '5',
      anchorDay: '',
      anchorTime: '09:00',
      timezone: 'Europe/London',
      memo: '',
      minSats: '',
      maxSats: '',
      commentChars: '0',
    };
    expect(
      buildAllowancePatch(
        { ...draft, memo: 'weekly allowance cleared' },
        100000,
      ),
    ).toMatch(/must not contain/);
    expect(buildAllowancePatch(draft, 1000)).toMatch(/cannot exceed/);
    expect(
      buildAllowancePatch({ ...draft, minSats: '1', maxSats: '10' }, 100000),
    ).toMatch(/include the amount/);
    expect(buildAllowancePatch({ ...draft, minSats: '1' }, 100000)).toMatch(
      /both/,
    );
    expect(
      buildAllowancePatch({ ...draft, anchorTime: '9am' }, 100000),
    ).toMatch(/HH:mm/);
    expect(
      buildAllowancePatch({ ...draft, enabled: false, amount: '' }, 100000),
    ).toEqual(expect.objectContaining({ enabled: false, amountSats: null }));
  });
});
