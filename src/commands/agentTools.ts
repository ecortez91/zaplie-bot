// agentTools.ts
//
// Read-only tools for the Foundry conversational agent. Each returns structured
// data (not a chat activity) so the agent decides how to phrase the reply.

import { TurnContext } from 'botbuilder';
import { ToolDefinition } from '../services/foundryAgentService';
import { getUserWallets } from '../services/lnbitsService';
import {
  getZapActivity,
  getZapLeaderboard,
} from '../services/zapHistoryService';
import { isAllowanceWallet, isPrivateWallet } from '../services/walletNames';
import { getRecentMeetings, getRelevantPeople } from '../services/graphService';
import {
  CONNECT_CALENDAR_COMMAND,
  getStoredGraphToken,
} from './connectCalendarCommand';

const adminKey = process.env.LNBITS_ADMINKEY as string;
const rewardLabel = process.env.LNBITS_POINTS_LABEL as string;

const toSats = (balanceMsat: number): number => Math.floor(balanceMsat / 1000);

// Shares the wallet-name rule with the leaderboard, so a casing difference
// cannot make a wallet count towards a ranking but vanish from a balance reply.
const isBalanceWallet = (wallet: Wallet): boolean =>
  isAllowanceWallet(wallet.name) || isPrivateWallet(wallet.name);

const SECONDS_PER_DAY = 86400;

// The leaderboard's window is open-ended by default (all-time), unlike the
// calendar tools' rolling week, so it gets its own parameter rather than
// reusing DAYS_PARAMETER's "defaults to 7" contract.
const LEADERBOARD_DAYS_PARAMETER = {
  type: 'number',
  description:
    'Only count zaps sent in the last N days (e.g. 7 for "this week"). ' +
    'Capped at 365. Omit for all-time totals.',
};

const leaderboardSinceTimestamp = (days?: number): number | undefined => {
  if (typeof days !== 'number' || !Number.isFinite(days)) return undefined;
  const periodDays = Math.min(Math.max(Math.floor(days), 1), 365);
  return Math.floor(Date.now() / 1000) - periodDays * SECONDS_PER_DAY;
};

// Team-wide reads can miss a user or a wallet (a rate-limited LNbits response,
// say). Saying so lets the assistant hedge instead of presenting a ranking with
// someone silently missing from it as complete.
const coverageNote = (coverage: {
  partial: boolean;
  skippedUsers: number;
  skippedWallets: number;
}): string | undefined =>
  coverage.partial
    ? `Some LNbits reads failed (${coverage.skippedUsers} user(s), ` +
      `${coverage.skippedWallets} wallet(s) skipped), so these totals are a ` +
      'lower bound. Tell the user the ranking may be incomplete.'
    : undefined;

const DAYS_PARAMETER = {
  type: 'number',
  description: 'Look-back window in days. Defaults to 7, capped at 30.',
};

const clampDays = (days?: number): number =>
  typeof days === 'number' && Number.isFinite(days)
    ? Math.min(Math.max(Math.floor(days), 1), 30)
    : 7;

const getMyBalanceTool: ToolDefinition = {
  name: 'get_my_balance',
  description: "Get the current user's Allowance and Private wallet balances.",
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const user = turnContext.turnState.get('user') as User;
    const wallets = await getUserWallets(adminKey, user.id);
    return {
      rewardLabel,
      wallets: wallets.filter(isBalanceWallet).map(wallet => ({
        name: wallet.name,
        balanceSats: toSats(wallet.balance_msat),
      })),
    };
  },
};

const getLeaderboardTool: ToolDefinition = {
  name: 'get_leaderboard',
  description:
    'Get the team leaderboard, ranked by the sats each teammate has zapped to others ' +
    'out of their Allowance wallet. Private wallet balances are never ranked.',
  parameters: {
    type: 'object',
    properties: { days: LEADERBOARD_DAYS_PARAMETER },
    required: [],
  },
  handler: async (args: { days?: number }) => {
    const sinceTimestamp = leaderboardSinceTimestamp(args?.days);
    const leaderboard = await getZapLeaderboard({ sinceTimestamp });
    return {
      rewardLabel,
      periodDays: sinceTimestamp ? Math.floor(args.days as number) : null,
      partial: leaderboard.partial,
      incompleteReason: coverageNote(leaderboard),
      leaderboard: leaderboard.entries.map(entry => ({
        displayName: entry.user.displayName,
        zappedSats: entry.zappedSats,
      })),
    };
  },
};

const getRecentActivityTool: ToolDefinition = {
  name: 'get_recent_activity',
  description:
    'Get recent zaps sent across the team: who sent what to whom, how much, and why (the memo). ' +
    'Use this for "recent rewards", "why was I zapped", or "team activity" questions.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description:
          'Max number of recent zaps to return. Defaults to 20, capped at 50.',
      },
      onlyInvolvingMe: {
        type: 'boolean',
        description:
          'If true, only include zaps where the current user is the sender or receiver.',
      },
    },
    required: [],
  },
  handler: async (
    args: { limit?: number; onlyInvolvingMe?: boolean },
    turnContext: TurnContext,
  ) => {
    const user = turnContext.turnState.get('user') as User;
    const limit =
      typeof args.limit === 'number'
        ? Math.min(Math.max(args.limit, 1), 50)
        : 20;
    const activity = await getZapActivity({
      limit,
      userAadObjectId: args.onlyInvolvingMe ? user.aadObjectId : undefined,
    });
    return {
      rewardLabel,
      partial: activity.partial,
      incompleteReason: coverageNote(activity),
      activity: activity.zaps.map(entry => ({
        from: entry.from?.displayName || 'Unknown',
        to: entry.to?.displayName || 'Unknown',
        amountSats: entry.amountSats,
        memo: entry.memo,
        time: entry.time.toISOString(),
      })),
    };
  },
};

const getRecentMeetingsTool: ToolDefinition = {
  name: 'get_recent_meetings',
  description:
    "Get the current user's recent meetings using delegated, read-only Microsoft Graph access. " +
    'Combine the result with get_recent_activity when suggesting recognition.',
  parameters: {
    type: 'object',
    properties: { days: DAYS_PARAMETER },
    required: [],
  },
  handler: async (args: { days?: number }, turnContext: TurnContext) => {
    const token = await getStoredGraphToken(turnContext);
    if (!token) {
      return {
        connected: false,
        message: `Ask the user to type "${CONNECT_CALENDAR_COMMAND}" before using work signals.`,
      };
    }
    const periodDays = clampDays(args.days);
    return {
      connected: true,
      periodDays,
      meetings: await getRecentMeetings(token, periodDays),
    };
  },
};

const getFrequentCollaboratorsTool: ToolDefinition = {
  name: 'get_frequent_collaborators',
  description:
    'Get people most relevant to the current user across Microsoft 365 communication signals. ' +
    'No message content is returned. Combine with get_recent_activity when suggesting recognition.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, turnContext: TurnContext) => {
    const token = await getStoredGraphToken(turnContext);
    if (!token) {
      return {
        connected: false,
        message: `Ask the user to type "${CONNECT_CALENDAR_COMMAND}" before using work signals.`,
      };
    }
    return {
      connected: true,
      collaborators: await getRelevantPeople(token, 10),
    };
  },
};

export function createReadOnlyTools(): ToolDefinition[] {
  return [
    getMyBalanceTool,
    getLeaderboardTool,
    getRecentActivityTool,
    ...(process.env.GRAPH_CONNECTION_NAME
      ? [getRecentMeetingsTool, getFrequentCollaboratorsTool]
      : []),
  ];
}
