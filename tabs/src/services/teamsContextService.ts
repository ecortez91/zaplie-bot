import { queryOptions } from '@tanstack/react-query';
import * as microsoftTeams from '@microsoft/teams-js';
import { TEAMS_CONTEXT_TIMEOUT_MS, withTimeout } from './teamsTimeout';

export const teamsContextQueryKey = ['host', 'teams'] as const;

// Any failure means "not in Teams", so detection always settles and the app
// falls back to browser mode. teams-js cannot tell "no host" (initialize
// rejects at once) from "a host that never answers" (a timeout): both reject.
// Inside a Teams iframe the browser fallback is safe: MSAL logoutRedirect fails
// its redirect_in_iframe preflight and sign-out shows the usual error toast.
// initialize is bounded by teams-js (60 s); getContext is bounded here.
export const detectTeamsContext = async (): Promise<boolean> => {
  try {
    if (!microsoftTeams.app.isInitialized()) {
      await microsoftTeams.app.initialize();
    }

    await withTimeout(
      microsoftTeams.app.getContext(),
      TEAMS_CONTEXT_TIMEOUT_MS,
      'Timed out waiting for the Teams context.',
    );
    return true;
  } catch (error) {
    console.debug('Teams host not detected; using browser mode.', error);
    return false;
  }
};

export const teamsContextQueryOptions = queryOptions({
  queryKey: teamsContextQueryKey,
  queryFn: detectTeamsContext,
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  retryOnMount: false,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  networkMode: 'always',
});
