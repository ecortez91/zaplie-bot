import React from 'react';
import { useLocation } from 'react-router-dom';
import { AuthenticatedTemplate } from '@azure/msal-react';
import FooterComponent from './FooterComponent';
import HeaderComponent from './HeaderComponent';
import styles from './PageLayout.module.css';

type Props = {
  children?: React.ReactNode;
};

export const PageLayout: React.FC<Props> = ({ children }) => {
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const hideNavBar = queryParams.get('hideNavBar') === 'true';
  // The sign-in page is a full-screen background, not a content column: in
  // the 1200px column it leaves empty bands either side inside a wide tab.
  // Matched the way the router matches the route: case-insensitive, with or
  // without a trailing slash.
  const fullBleed = /^\/login\/?$/i.test(location.pathname);

  return (
    <div className={styles.pageContainer}>
      <AuthenticatedTemplate>
        <HeaderComponent />
      </AuthenticatedTemplate>
      <div className={fullBleed ? styles.fullBleed : styles.contentWrap}>
        {children}
      </div>
      <AuthenticatedTemplate>
        <FooterComponent hidden={hideNavBar} />
      </AuthenticatedTemplate>
    </div>
  );
};
