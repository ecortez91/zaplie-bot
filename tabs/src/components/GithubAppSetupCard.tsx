import React, { FunctionComponent, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { toast } from 'react-toastify';
import styles from './AutomationsComponent.module.css';
import { acquireIdToken } from '../services/adminRole';
import {
  getGithubSetupStatus,
  GithubSetupStatus,
  startGithubAppCreation,
} from '../services/setupService';

// Strips the ?setup=... param the manifest callback returns to Automations
// with, after surfacing it as a toast, so a page refresh doesn't re-show it.
export const useGithubSetupReturnStatus = () => {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('setup');
    if (!status) {
      return;
    }
    if (status === 'github_created') {
      toast.success('GitHub App created. You can connect repositories now.');
    } else {
      toast.error('Creating the GitHub App failed. Please try again.');
    }
    params.delete('setup');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, []);
};

// Repositories can be connected once the app exists, from either source.
export const isGithubAppReady = (status: GithubSetupStatus) =>
  status.created || status.source === 'env';

// Admin-only block inside the GitHub connection card: creates the org's own
// GitHub App through the manifest flow. Mount it keyed by account so a switch
// never shows the previous account's status.
const GithubAppSetupCard: FunctionComponent<{
  onStatus: (status: GithubSetupStatus) => void;
}> = ({ onStatus }) => {
  const { instance, accounts } = useMsal();
  const [status, setStatus] = useState<GithubSetupStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const account = accounts[0];
        if (!account) {
          return;
        }
        const idToken = await acquireIdToken(instance, account);
        const next = await getGithubSetupStatus(idToken);
        if (cancelled) {
          return;
        }
        setStatus(next);
        onStatus(next);
      } catch (err) {
        if (cancelled) {
          return;
        }
        console.error('Error fetching GitHub App status:', err);
        setLoadError(true);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
    // Mounted per account; `accounts` gets a new identity on every token
    // refresh and must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    const account = accounts[0];
    if (!account) {
      return;
    }
    setCreating(true);
    try {
      const idToken = await acquireIdToken(instance, account);
      // Navigates away to GitHub; the button stays disabled until it does.
      await startGithubAppCreation(idToken);
    } catch (err) {
      console.error('Error starting GitHub App creation:', err);
      toast.error('Could not start creating the GitHub App.');
      setCreating(false);
    }
  };

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <span className={styles.appSetupStatus} role="alert">
        GitHub App status is unavailable right now.
      </span>
    );
  } else if (!status) {
    body = (
      <span className={styles.appSetupStatus}>Checking the GitHub App…</span>
    );
  } else if (status.source === 'env') {
    body = (
      <span className={styles.appSetupStatus}>
        GitHub App: configured by environment
      </span>
    );
  } else if (status.created) {
    body = (
      <span className={styles.appSetupStatus}>
        App created:{' '}
        {status.htmlUrl ? (
          <a href={status.htmlUrl} target="_blank" rel="noopener noreferrer">
            {status.slug}
          </a>
        ) : (
          status.slug
        )}
      </span>
    );
  } else {
    body = (
      <>
        <span className={styles.appSetupStatus}>GitHub App: not created</span>
        <button
          type="button"
          className={styles.installButton}
          onClick={handleCreate}
          disabled={creating}
        >
          {creating
            ? 'Redirecting to GitHub...'
            : 'Create the Zaplie GitHub App'}
        </button>
      </>
    );
  }

  return (
    <div className={styles.appSetup} aria-busy={!status && !loadError}>
      {body}
    </div>
  );
};

export default GithubAppSetupCard;
