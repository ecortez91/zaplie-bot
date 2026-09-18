import {
  parseAutomationsResponse,
  parseRewardAmountsResponse,
  parseRewardNameResponse,
} from '../apiService';
import { parseAutomationsStats } from './automationsStatsService';
import { parseReportsData } from './reportsService';
import { parseCreatedWebhookKey, parseWebhookKeys } from './webhookKeysService';

describe('service response contracts', () => {
  test('rejects malformed reports instead of passing undefined series to charts', () => {
    expect(() => parseReportsData({})).toThrow(
      'Reports response is malformed.',
    );
    expect(() =>
      parseReportsData({
        weeks: 2,
        zapsWeekly: [10],
        automationWeekly: [5, 8],
        totalZapSats: 10,
        totalZapCount: 1,
        totalAutomatedSats: 13,
        totalAutomatedCount: 2,
      }),
    ).toThrow('Reports response is malformed.');
  });

  test('rejects missing automation arrays before rendering filters', () => {
    expect(() => parseAutomationsStats({})).toThrow(
      'Automations stats response is malformed.',
    );
    expect(() =>
      parseAutomationsStats({
        paidSatsThisMonth: 1,
        paymentsThisMonth: 1,
        runsByEventType: { pull_request: '1' },
        engagementByAudience: {
          teammates: [],
          copilots: [],
          customers: [],
        },
        recentPayments: [],
      }),
    ).toThrow('Automations stats response is malformed.');
  });

  test('rejects a webhook response without a keys array', () => {
    expect(() => parseWebhookKeys({})).toThrow(
      'Webhook keys response is malformed.',
    );
    expect(() => parseWebhookKeys({ keys: [{}] })).toThrow(
      'Webhook keys response is malformed.',
    );
    expect(() => parseCreatedWebhookKey({ id: 'key-id' })).toThrow(
      'Created webhook key response is malformed.',
    );
  });
});

describe('service response contracts — accepted backend payloads', () => {
  // The fixtures below mirror what the Express backend actually sends, so a
  // parser that is too strict fails here rather than in production.

  test('accepts the weekly series reportsRoutes.js builds (WEEKS = 8)', () => {
    const payload = {
      weeks: 8,
      zapsWeekly: [0, 0, 120, 340, 0, 55, 900, 1200],
      automationWeekly: [0, 0, 0, 1000, 500, 0, 300, 2000],
      totalZapSats: 2615,
      totalZapCount: 12,
      totalAutomatedSats: 3800,
      totalAutomatedCount: 5,
    };

    expect(parseReportsData(payload)).toEqual(payload);
  });

  test('accepts an all-zero week, which is what a quiet tenant returns', () => {
    const payload = {
      weeks: 8,
      zapsWeekly: [0, 0, 0, 0, 0, 0, 0, 0],
      automationWeekly: [0, 0, 0, 0, 0, 0, 0, 0],
      totalZapSats: 0,
      totalZapCount: 0,
      totalAutomatedSats: 0,
      totalAutomatedCount: 0,
    };

    expect(parseReportsData(payload)).toEqual(payload);
  });

  test('accepts the summary summarizeAutomationPayments returns', () => {
    const recipient = {
      id: 'user-1',
      displayName: 'Ada Lovelace',
      audience: 'teammates' as const,
      paymentCount: 3,
      paidSats: 2500,
      lastPaidAt: '2026-08-14T09:15:00.000Z',
    };
    const payload = {
      paidSatsThisMonth: 2500,
      paymentsThisMonth: 3,
      runsByEventType: { pull_request: 2, issues: 1 },
      engagementByAudience: {
        teammates: [
          recipient,
          {
            // audienceForUser(undefined) returns 'teammates', so this is the
            // bucket buildRecipient puts an unresolvable recipient in.
            id: 'unattributed',
            displayName: 'Unattributed recipient',
            audience: 'teammates' as const,
            paymentCount: 1,
            paidSats: 250,
            lastPaidAt: null,
          },
        ],
        copilots: [],
        customers: [
          {
            id: 'guest-1',
            displayName: 'Acme Corp',
            audience: 'customers' as const,
            paymentCount: 1,
            paidSats: 500,
            // Null when the LNbits payment carried no usable timestamp.
            lastPaidAt: null,
          },
        ],
      },
      recentPayments: [
        {
          id: 'payment-hash-1',
          amountSats: 1000,
          memo: 'Automated reward',
          source: 'automation',
          paidAt: '2026-08-14T09:15:00.000Z',
          recipient: {
            id: recipient.id,
            displayName: recipient.displayName,
            audience: recipient.audience,
          },
        },
        {
          id: '1755000000--1000000',
          amountSats: 1000,
          memo: 'PR merged',
          source: 'github',
          paidAt: null,
          recipient: {
            id: 'unattributed',
            displayName: 'Unattributed recipient',
            audience: 'teammates' as const,
          },
        },
      ],
    };

    expect(parseAutomationsStats(payload)).toEqual(payload);
  });

  test('accepts an empty automations summary from a tenant with no payouts', () => {
    const payload = {
      paidSatsThisMonth: 0,
      paymentsThisMonth: 0,
      runsByEventType: {},
      engagementByAudience: { teammates: [], copilots: [], customers: [] },
      recentPayments: [],
    };

    expect(parseAutomationsStats(payload)).toEqual(payload);
  });

  test('accepts the key list and creation payloads webhookKeysRoutes.js sends', () => {
    const keys = [
      {
        id: '6f0b1e2c-6a4d-4c1a-9a0d-0b6a9c2f1e33',
        label: 'GitHub Logic App',
        last4: 'a1b2',
        createdAt: '2026-08-01T10:00:00.000Z',
        revokedAt: null,
      },
      {
        id: '0d0f4a7b-2f6c-4a19-8a3b-9f2c5d7e1a44',
        label: 'Retired runner',
        last4: 'c3d4',
        createdAt: '2026-07-02T08:30:00.000Z',
        revokedAt: '2026-07-20T12:00:00.000Z',
      },
    ];

    expect(parseWebhookKeys({ keys })).toEqual(keys);
    expect(parseWebhookKeys({ keys: [] })).toEqual([]);

    // The create route returns label/last4/createdAt alongside the plaintext
    // key; the parser keeps only what the UI needs. The fixture is a literal
    // placeholder, not a key shape, so the secret scanner stays quiet.
    const PLACEHOLDER_KEY = 'zpl_placeholder_not_a_real_key';
    expect(
      parseCreatedWebhookKey({
        key: PLACEHOLDER_KEY,
        id: keys[0].id,
        label: keys[0].label,
        last4: keys[0].last4,
        createdAt: keys[0].createdAt,
      }),
    ).toEqual({ key: PLACEHOLDER_KEY, id: keys[0].id });
  });

  test('accepts the flat integer map rewardAmounts.js stores', () => {
    const rewardAmounts = {
      githubPrMergedSats: 1000,
      githubIssueClosedSats: 500,
      githubReviewSubmittedSats: 300,
    };

    expect(parseRewardAmountsResponse({ rewardAmounts })).toEqual({
      rewardAmounts,
    });
    // validateRewardAmountPatch rejects anything <= 0, so a retuned rule is
    // still a positive integer.
    expect(
      parseRewardAmountsResponse({
        rewardAmounts: { ...rewardAmounts, githubPrMergedSats: 250 },
      }),
    ).toEqual({
      rewardAmounts: { ...rewardAmounts, githubPrMergedSats: 250 },
    });
  });

  test('accepts the repo list and reward name the config routes return', () => {
    expect(
      parseAutomationsResponse({ repos: ['knowall-ai/zaplie-bot'] }),
    ).toEqual({ repos: ['knowall-ai/zaplie-bot'] });
    expect(parseAutomationsResponse({ repos: [] })).toEqual({ repos: [] });
    expect(parseRewardNameResponse({ rewardName: 'Sats' })).toEqual({
      rewardName: 'Sats',
    });
  });
});
