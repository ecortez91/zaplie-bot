import axios from 'axios';
import { apiUrl } from './services/appLocation';
import { isFiniteNumber } from './services/validators';

const API_URL = apiUrl('/api');

export interface RewardNameResponse {
  rewardName: string;
}

export const parseRewardNameResponse = (data: unknown): RewardNameResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The reward name response was invalid.');
  }

  const rewardName = (data as { rewardName?: unknown }).rewardName;
  if (typeof rewardName !== 'string' || !rewardName.trim()) {
    throw new Error('The reward name response was invalid.');
  }

  return { rewardName: rewardName.trim() };
};

export const getRewardName = async (): Promise<RewardNameResponse> => {
  const response = await axios.get(`${API_URL}/reward-name`);
  return parseRewardNameResponse(response.data);
};

export const updateRewardName = async (
  idToken: string,
  newRewardName: string,
): Promise<RewardNameResponse> => {
  const normalizedRewardName = newRewardName.trim();
  if (!normalizedRewardName) {
    throw new Error('The reward name cannot be empty.');
  }

  const response = await axios.post(
    `${API_URL}/reward-name`,
    { newRewardName: normalizedRewardName },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseRewardNameResponse(response.data);
};

export interface RewardAmountsResponse {
  rewardAmounts: Record<string, number>;
}

export interface AutomationsResponse {
  repos: string[];
}

export const parseRewardAmountsResponse = (
  data: unknown,
): RewardAmountsResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The reward amounts response was invalid.');
  }

  const rewardAmounts = (data as { rewardAmounts?: unknown }).rewardAmounts;
  if (
    !rewardAmounts ||
    typeof rewardAmounts !== 'object' ||
    Array.isArray(rewardAmounts) ||
    !Object.values(rewardAmounts).every(isFiniteNumber)
  ) {
    throw new Error('The reward amounts response was invalid.');
  }

  return { rewardAmounts: rewardAmounts as Record<string, number> };
};

export const parseAutomationsResponse = (
  data: unknown,
): AutomationsResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The automations response was invalid.');
  }

  const repos = (data as { repos?: unknown }).repos;
  if (
    !Array.isArray(repos) ||
    !repos.every(repo => typeof repo === 'string' && repo.length > 0)
  ) {
    throw new Error('The automations response was invalid.');
  }

  return { repos };
};

export interface BotPersonaResponse {
  botPersona: string;
}

// Kept in step with backend/botPersona.js: the editor stops the admin at the
// limit, the backend is what actually enforces it.
export const MAX_BOT_PERSONA_LENGTH = 2000;

const parseBotPersonaResponse = (data: unknown): BotPersonaResponse => {
  if (!data || typeof data !== 'object') {
    throw new Error('The assistant persona response was invalid.');
  }

  const botPersona = (data as { botPersona?: unknown }).botPersona;
  // An empty persona is the normal "built-in voice" state, so only the type
  // matters here.
  if (typeof botPersona !== 'string') {
    throw new Error('The assistant persona response was invalid.');
  }

  return { botPersona };
};

export const getBotPersona = async (
  idToken: string,
): Promise<BotPersonaResponse> => {
  const response = await axios.get(`${API_URL}/bot-persona`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseBotPersonaResponse(response.data);
};

export const updateBotPersona = async (
  idToken: string,
  botPersona: string,
): Promise<BotPersonaResponse> => {
  const response = await axios.post(
    `${API_URL}/bot-persona`,
    { botPersona: botPersona.trim() },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseBotPersonaResponse(response.data);
};

export const getRewardAmounts = async (
  idToken: string,
): Promise<RewardAmountsResponse> => {
  const response = await axios.get(`${API_URL}/reward-amounts`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseRewardAmountsResponse(response.data);
};

export const updateRewardAmounts = async (
  idToken: string,
  rewardAmounts: Record<string, number>,
): Promise<RewardAmountsResponse> => {
  const response = await axios.post(
    `${API_URL}/reward-amounts`,
    { rewardAmounts },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseRewardAmountsResponse(response.data);
};

export const getAutomations = async (
  idToken: string,
): Promise<AutomationsResponse> => {
  const response = await axios.get(`${API_URL}/automations`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseAutomationsResponse(response.data);
};

export const updateAutomations = async (
  idToken: string,
  repos: string[],
): Promise<AutomationsResponse> => {
  const response = await axios.post(
    `${API_URL}/automations`,
    { repos },
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );
  return parseAutomationsResponse(response.data);
};

// Reward policy: what the bot pays from. Kept in step with
// backend/rewardPolicy.js, which is what actually enforces every rule.
export type RewardEventType =
  'githubPrMerged' | 'githubIssueClosed' | 'githubReviewSubmitted';

export interface LevelRule {
  labelPrefix: string;
  bonuses: Record<string, number>;
}

export interface RewardBudget {
  period: 'week' | 'month';
  capSats: number;
  timezone: string;
}

export interface RewardPolicy {
  version: 1;
  levels: Partial<Record<RewardEventType, LevelRule>>;
  overrides: Record<
    string,
    Partial<Record<RewardEventType, { baseSats: number }>>
  >;
  budget: RewardBudget | null;
}

export interface RewardPolicyResponse {
  // Only the amounts an admin saved: a missing rule pays nothing.
  rewardAmounts: Record<string, number>;
  rewardPolicy: RewardPolicy;
  // REWARDS_MAX_AMOUNT_SATS, so the editor can stop an over-cap value early.
  maxAmountSats: number;
}

export type RewardPolicyPatch = Partial<
  Pick<RewardPolicy, 'levels' | 'overrides' | 'budget'>
>;

export interface Person {
  personAad: string;
  displayName: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isPositiveInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value > 0;

const isPositiveIntegerRecord = (value: unknown): boolean =>
  isPlainObject(value) && Object.values(value).every(isPositiveInteger);

const isLevelRule = (value: unknown): value is LevelRule =>
  isPlainObject(value) &&
  typeof value.labelPrefix === 'string' &&
  isPositiveIntegerRecord(value.bonuses);

const isBudget = (value: unknown): value is RewardBudget =>
  isPlainObject(value) &&
  (value.period === 'week' || value.period === 'month') &&
  isPositiveInteger(value.capSats) &&
  typeof value.timezone === 'string';

const isOverrides = (value: unknown): boolean =>
  isPlainObject(value) &&
  Object.values(value).every(
    perEvent =>
      isPlainObject(perEvent) &&
      Object.values(perEvent).every(
        override =>
          isPlainObject(override) && isPositiveInteger(override.baseSats),
      ),
  );

export const parseRewardPolicyResponse = (
  data: unknown,
): RewardPolicyResponse => {
  const invalid = new Error('The reward policy response was invalid.');
  if (!isPlainObject(data) || !isPlainObject(data.rewardPolicy)) {
    throw invalid;
  }
  const { rewardAmounts, rewardPolicy, maxAmountSats } = data;
  const policy = rewardPolicy as Record<string, unknown>;
  if (
    !isPositiveIntegerRecord(rewardAmounts) ||
    !isPositiveInteger(maxAmountSats) ||
    policy.version !== 1 ||
    !isPlainObject(policy.levels) ||
    !Object.values(policy.levels).every(isLevelRule) ||
    !isOverrides(policy.overrides) ||
    !(policy.budget === null || isBudget(policy.budget))
  ) {
    throw invalid;
  }
  return {
    rewardAmounts: rewardAmounts as Record<string, number>,
    rewardPolicy: rewardPolicy as unknown as RewardPolicy,
    maxAmountSats,
  };
};

export const getRewardPolicy = async (
  idToken: string,
): Promise<RewardPolicyResponse> => {
  const response = await axios.get(`${API_URL}/reward-policy`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseRewardPolicyResponse(response.data);
};

export const updateRewardPolicy = async (
  idToken: string,
  patch: RewardPolicyPatch,
): Promise<RewardPolicyResponse> => {
  const response = await axios.post(`${API_URL}/reward-policy`, patch, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseRewardPolicyResponse(response.data);
};

export const parsePeopleResponse = (data: unknown): Person[] => {
  const people = isPlainObject(data) ? data.people : undefined;
  if (
    !Array.isArray(people) ||
    !people.every(
      person =>
        isPlainObject(person) &&
        typeof person.personAad === 'string' &&
        typeof person.displayName === 'string',
    )
  ) {
    throw new Error('The people response was invalid.');
  }
  return people.map(person => ({
    personAad: person.personAad as string,
    displayName: person.displayName as string,
  }));
};

// Admin only: names and Entra object ids for the per-person override picker.
export const getPeople = async (idToken: string): Promise<Person[]> => {
  const response = await axios.get(`${API_URL}/identities/people`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parsePeopleResponse(response.data);
};

// Weekly allowances: the policy the portal backend reconciles the LNbits
// allowance extension with (backend/allowancePolicy.js enforces every rule).
// The extension pays from the Fund wallet; nothing here ever carries a key.
export type AllowancePeriod = 'weekly' | 'monthly';

export interface AllowancePolicy {
  version: 1;
  enabled: boolean;
  amountSats: number | null;
  period: AllowancePeriod | null;
  anchorWeekday: number | null;
  anchorDay: number | null;
  anchorTime: string | null;
  timezone: string | null;
  memo: string;
  payLink: {
    minSats: number | null;
    maxSats: number | null;
    commentChars: number;
  };
  overwriteDrift: boolean;
  excludedOids: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export type AllowancePolicyPatch = Partial<
  Omit<AllowancePolicy, 'version' | 'updatedAt' | 'updatedBy'>
>;

export interface AllowanceFundWallet {
  id: string | null;
  name: string;
  balanceSats: number | null;
}

export interface AllowanceHealth {
  healthy: boolean;
  schedulerOk: boolean;
  lastCompleted: number | null;
  overdue: number | null;
  pending: number | null;
}

export interface AllowanceRunSummary {
  mode: 'dry' | 'apply';
  at: string;
  finishedAt?: string;
  by: string;
  created: number;
  updated: number;
  deleted: number;
  payLinks: number;
  drift: number;
  errors: number;
  aborted: string | null;
  totalPerPeriodSats: number;
}

export interface AllowanceStatus {
  policy: AllowancePolicy;
  maxAmountSats: number;
  fund: {
    configured: boolean;
    wallets: AllowanceFundWallet[];
    health: AllowanceHealth | null;
    error?: string;
  };
  lastRun: AllowanceRunSummary | null;
  lastAdminApply: {
    policyUpdatedAt: string | null;
    totalPerPeriodSats: number;
    at: string;
    by: string;
  } | null;
  running: boolean;
  timer: {
    enabled: boolean;
    disabled: boolean;
    invalid: boolean;
    intervalMinutes: number;
  };
}

export interface AllowanceSyncAction {
  kind: string;
  oid: string | null;
  displayName: string | null;
  reason: string | null;
  fields?: string[];
  amountSats?: number;
  lightningAddress?: string;
  startDatetime?: string;
  error?: string;
}

export interface AllowanceSyncSummary {
  policyEnabled: boolean;
  fundConfigured: boolean;
  people: number;
  paylinkCreates: number;
  paylinkUpdates: number;
  creates: number;
  updates: number;
  recreates: number;
  deletes: number;
  noop: number;
  drift: number;
  paused: number;
  deferred: number;
  skipped: number;
  changes: number;
  amountSats: number | null;
  totalPerPeriodSats: number;
  fundBalanceSats: number;
  nextStart: string | null;
}

export interface AllowanceNotice {
  code: string;
  message: string;
  overridable?: boolean;
}

export interface AllowanceSyncResult {
  mode: 'dry' | 'apply';
  at: string;
  summary: AllowanceSyncSummary;
  warnings: AllowanceNotice[];
  blockers: AllowanceNotice[];
  actions: AllowanceSyncAction[];
  result?: AllowanceRunSummary;
  errors?: AllowanceSyncAction[];
}

const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

export const parseAllowanceStatus = (data: unknown): AllowanceStatus => {
  const invalid = new Error('The allowance status response was invalid.');
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.policy) ||
    typeof data.policy.enabled !== 'boolean' ||
    !(
      data.policy.amountSats === null ||
      isPositiveInteger(data.policy.amountSats)
    ) ||
    !isPlainObject(data.policy.payLink) ||
    !isPositiveInteger(data.maxAmountSats) ||
    !isPlainObject(data.fund) ||
    typeof data.fund.configured !== 'boolean' ||
    !Array.isArray(data.fund.wallets) ||
    !isPlainObject(data.timer)
  ) {
    throw invalid;
  }
  return data as unknown as AllowanceStatus;
};

export const parseAllowanceSyncResult = (
  data: unknown,
): AllowanceSyncResult => {
  const invalid = new Error('The allowance sync response was invalid.');
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.summary) ||
    !isNonNegativeInteger(data.summary.totalPerPeriodSats) ||
    !isNonNegativeInteger(data.summary.changes) ||
    !Array.isArray(data.actions) ||
    !Array.isArray(data.warnings) ||
    !Array.isArray(data.blockers)
  ) {
    throw invalid;
  }
  return data as unknown as AllowanceSyncResult;
};

export const getAllowanceStatus = async (
  idToken: string,
): Promise<AllowanceStatus> => {
  const response = await axios.get(`${API_URL}/allowances/policy`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseAllowanceStatus(response.data);
};

export const updateAllowancePolicy = async (
  idToken: string,
  patch: AllowancePolicyPatch,
): Promise<AllowanceStatus> => {
  const response = await axios.post(`${API_URL}/allowances/policy`, patch, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return parseAllowanceStatus(response.data);
};

export const previewAllowanceSync = async (
  idToken: string,
  options: { overwriteDrift: boolean },
): Promise<AllowanceSyncResult> => {
  const response = await axios.post(
    `${API_URL}/allowances/sync?mode=dry`,
    { overwriteDrift: options.overwriteDrift },
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return parseAllowanceSyncResult(response.data);
};

// Apply echoes the preview's total per period: the server refuses (409) if
// the plan it computes now has a different total.
export const applyAllowanceSync = async (
  idToken: string,
  options: {
    confirmTotalSats: number;
    overwriteDrift: boolean;
    allowUnderfunded: boolean;
    allowMassDelete: boolean;
  },
): Promise<AllowanceSyncResult> => {
  const response = await axios.post(
    `${API_URL}/allowances/sync?mode=apply`,
    options,
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return parseAllowanceSyncResult(response.data);
};
