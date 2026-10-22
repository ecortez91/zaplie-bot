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
        const { user } = await microsoftTeams.app.getContext();
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
