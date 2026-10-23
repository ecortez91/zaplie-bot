import { SSOCommand } from './SSOCommandMap';
import { TurnContext, CardFactory } from 'botbuilder';
import { getWallets, getUsers } from '../services/lnbitsService';
import { LocaleTag, en, formatNumber, t } from '../i18n';

const adminKey = process.env.LNBITS_ADMINKEY as string;

// Names what the numbers actually are. LNbits exposes a wallet balance, not a
// received-zaps total, so a title promising "zaps received" would misreport a
// user who has spent or withdrawn from their Private wallet. The copy lives in
// src/i18n; these constants are the English renderings, kept for callers and
// tests that compare against them.
export const LEADERBOARD_TITLE = en.leaderboardTitle;
export const LEADERBOARD_EMPTY_MESSAGE = en.leaderboardEmpty;
export const LEADERBOARD_UNAVAILABLE_MESSAGE = en.leaderboardUnavailable;
export const LEADERBOARD_LIMIT = 10;

export interface LeaderboardEntry {
  displayName: string;
  amount: number;
}

// Builds the leaderboard card: a title, then one two-column row per leader
// (rank + name on the left, bold amount on the right), capped at the top
// LEADERBOARD_LIMIT entries. Entries must already be sorted. With no entries
// the card says so instead of showing a title over nothing.
export function buildLeaderboardCard(
  entries: LeaderboardEntry[],
  rewardName: string,
  portalUrl?: string,
  locale: LocaleTag = 'en',
) {
  const leaders = entries.slice(0, LEADERBOARD_LIMIT);
  return {
    type: 'AdaptiveCard',
    body: [
      {
        type: 'TextBlock',
        text: t(locale, 'leaderboardTitle'),
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      ...(leaders.length === 0
        ? [
            {
              type: 'TextBlock',
              text: t(locale, 'leaderboardEmpty'),
              wrap: true,
            },
          ]
        : []),
      ...leaders.map((entry, index) => ({
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: `#${index + 1} ${entry.displayName}`,
                wrap: true,
              },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            items: [
              {
                type: 'TextBlock',
                text: `${formatNumber(entry.amount, locale)} ${rewardName}`,
                weight: 'Bolder',
              },
            ],
          },
        ],
      })),
    ],
    ...(portalUrl
      ? {
          actions: [
            {
              type: 'Action.OpenUrl',
              title: t(locale, 'leaderboardViewWallets'),
              url: `${portalUrl.replace(/\/+$/, '')}/wallet`,
            },
          ],
        }
      : {}),
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.2',
  };
}

// New command for showing leaderboard
export class ShowLeaderboardCommand extends SSOCommand {
  async execute(context: TurnContext): Promise<void> {
    // The raw tag: it picks the language and groups the amounts for the
    // client's region.
    const locale = context.activity?.locale;
    try {
      console.log('Showing leaderboard...');

      const globalRewardName = process.env.LNBITS_POINTS_LABEL as string;

      const [wallets, users] = await Promise.all([
        getWallets(adminKey, 'Private'),
        getUsers(adminKey, null),
      ]);
      // Silence is the wrong answer to a failed lookup: the user typed a
      // command and must be told it did not work.
      if (!users) {
        console.error('Leaderboard unavailable: LNbits returned no user list.');
        await context.sendActivity(t(locale, 'leaderboardUnavailable'));
        return;
      }

      // One getUsers call for every display name instead of a getUser
      // round-trip per wallet.
      const nameByUserId = new Map(
        users.map(individual => [individual.id, individual.displayName]),
      );

      const entries: LeaderboardEntry[] = [];
      for (const candidate of wallets.filter(candidateWallet =>
        candidateWallet.name.toLowerCase().includes('private'),
      )) {
        const displayName = nameByUserId.get(candidate.user);
        if (!displayName) {
          // Ranking a wallet we cannot attribute would publish a balance under
          // a placeholder name. Leave it out and flag it for an operator.
          console.warn(
            `Leaderboard: skipping wallet ${candidate.id}; its owner is missing from the LNbits user list.`,
          );
          continue;
        }
        entries.push({
          displayName,
          amount: candidate.balance_msat / 1000,
        });
      }

      // NOTE: the ranking is by Private wallet *balance*, not by a true
      // "zaps received" total — LNbits only exposes the balance, and a
      // withdrawal would lower a user's rank. Constraint of the LNbits
      // data model, which is why the title names the balance.
      // Equal balances are ordered by name so the card is stable between runs.
      entries.sort(
        (first, second) =>
          second.amount - first.amount ||
          first.displayName.localeCompare(second.displayName),
      );

      // The portal shares the PORTAL_URL name with tabs/backend (see
      // env/.env.dev.example). Without it there is no live portal to link
      // to, so the button is omitted rather than pointing at a dead URL.
      const cardResponse = buildLeaderboardCard(
        entries,
        globalRewardName,
        process.env.PORTAL_URL,
        locale,
      );

      // Send the formatted card as an activity
      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(cardResponse)],
      });
    } catch (error) {
      console.error('Error showing leaderboard:', error);
      await context.sendActivity(t(locale, 'leaderboardUnavailable'));
    }
  }
}
