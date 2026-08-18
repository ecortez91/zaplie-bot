import { Configuration, PopupRequest } from '@azure/msal-browser';

const requireConfig = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const AADclientid = requireConfig(
  process.env.REACT_APP_AAD_CLIENT_ID,
  'REACT_APP_AAD_CLIENT_ID',
);
const TenantId = requireConfig(
  process.env.REACT_APP_TENANT_ID,
  'REACT_APP_TENANT_ID',
);

export const msalConfig: Configuration = {
  auth: {
    clientId: AADclientid,
    authority: `https://login.microsoftonline.com/${TenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  system: {
    allowPlatformBroker: false, // Disables WAM Broker
    allowRedirectInIframe: false, // Prevent redirect in iframe
  },
  cache: {
    cacheLocation: 'localStorage', // This can be 'localStorage' or 'sessionStorage'
  },
};

export const loginRequest: PopupRequest = {
  scopes: ['User.Read'],
};
