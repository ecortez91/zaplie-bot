import React from 'react';
import styles from './SiteLink.module.css';
import { ZAPLIE_CONSTANTS } from '../constants/branding';
import { useTeamsAuth } from '../hooks/useTeamsAuth';

type SiteLinkProps = {
  // 'header' sits beside the wordmark; 'onDark' is for the sign-in page's
  // dark background.
  variant?: 'header' | 'onDark';
};

const websiteHost = new URL(ZAPLIE_CONSTANTS.website).host;

// The browser portal (getzapl.ie/portal) has no other way back to the
// website. Inside Teams there is no website to go back to, so nothing is
// shown there, nor while Teams detection is still running.
const SiteLink: React.FC<SiteLinkProps> = ({ variant = 'header' }) => {
  const { isInTeams, isTeamsInitializing } = useTeamsAuth();

  if (isInTeams || isTeamsInitializing) {
    return null;
  }

  return (
    <a
      href={ZAPLIE_CONSTANTS.website}
      className={`${styles.siteLink} ${styles[variant]}`}
    >
      <span aria-hidden="true">←</span> Back to {websiteHost}
    </a>
  );
};

export default SiteLink;
