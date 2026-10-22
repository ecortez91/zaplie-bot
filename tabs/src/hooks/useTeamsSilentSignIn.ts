import { useEffect, useRef, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import * as microsoftTeams from '@microsoft/teams-js';
import { loginRequest } from '../services/authConfig';
import {
  hasAttemptedSilentSignIn,
  markSilentSignInAttempted,
} from '../services/silentSignIn';
import { useTeamsAuth } from './useTeamsAuth';

// How long to wait for the Teams user before giving up on the silent sign-in.
// Teams already answered one getContext for the isInTeams check, so a reply
// normally takes milliseconds; MSAL's own ssoSilent timeout is 10 s.
export const TEAMS_CONTEXT_TIMEOUT_MS = 5000;

const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

interface UseTeamsSilentSignInReturn {
  attempting: boolean;
}

/**
 * Inside Teams, tries once per tab session to sign in without a click, using
 * the Entra session the Teams client already has (MSAL ssoSilent with the
 * Teams user as the login hint). Any failure is quiet: the Sign In button is
 * the fallback. Outside Teams it does nothing.
 */
export const useTeamsSilentSignIn = (): UseTeamsSilentSignInReturn => {
  const { instance, accounts, inProgress } = useMsal();
  const { isInTeams, isTeamsInitializing } = useTeamsAuth();
  const [attempting, setAttempting] = useState(false);
  const mountedRef = useRef(true);

  const shouldTry =
    isInTeams &&
    !isTeamsInitializing &&
    accounts.length === 0 &&
    inProgress === InteractionStatus.None;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!shouldTry || hasAttemptedSilentSignIn()) {
      return;
    }
    // Marked before the first await, so a re-render or a remount while the
    // attempt is in flight cannot start a second one.
    markSilentSignInAttempted();
    setAttempting(true);

    const signIn = async () => {
      try {
        const { user } = await withTimeout(
          microsoftTeams.app.getContext(),
          TEAMS_CONTEXT_TIMEOUT_MS,
          'Timed out waiting for the Teams context.',
        );
        const result = await instance.ssoSilent({
          ...loginRequest,
          loginHint: user?.loginHint ?? user?.userPrincipalName,
        });
        instance.setActiveAccount(result.account);
      } catch (error) {
        console.debug(
          'Silent Teams sign-in did not complete; showing the Sign In button.',
          error,
        );
      } finally {
        if (mountedRef.current) {
          setAttempting(false);
        }
      }
    };
    void signIn();
  }, [shouldTry, instance]);

  return { attempting };
};

export default useTeamsSilentSignIn;
