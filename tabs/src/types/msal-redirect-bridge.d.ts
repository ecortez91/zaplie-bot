// msal-browser publishes its redirect bridge as a package "exports" subpath,
// which TypeScript's "node" module resolution (used by this app) does not
// read. Webpack resolves it at build time; this declares its one export.
declare module '@azure/msal-browser/redirect-bridge' {
  import type { INavigationClient } from '@azure/msal-browser';

  export function broadcastResponseToMainFrame(
    navigationClient?: INavigationClient,
  ): Promise<void>;
}
