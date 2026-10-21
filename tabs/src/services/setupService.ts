import axios from 'axios';

// Where the GitHub App configuration in use comes from: GITHUB_* env vars on
// the server (they win), the credentials the manifest flow stored, or neither.
export type GithubConfigSource = 'env' | 'manifest' | 'none';

export interface GithubSetupStatus {
  // True only once the manifest flow has stored an App (slug and htmlUrl come
  // with it). An App configured purely by env vars reports false, with
  // source 'env'.
  created: boolean;
  slug?: string;
  htmlUrl?: string;
  source: GithubConfigSource;
  // The install link and the App key that lists an installation's
  // repositories both resolve on the server, from whichever source.
  installationReady: boolean;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
const auth = (idToken: string) => ({
  headers: { Authorization: `Bearer ${idToken}` },
});

export const getGithubSetupStatus = async (
  idToken: string,
): Promise<GithubSetupStatus> => {
  const response = await axios.get('/api/setup/github/status', auth(idToken));
  return response.data;
};

// Submits a real form POST to GitHub's App registration page: GitHub only
// accepts the manifest as a posted form field, not as a redirect parameter.
// With an organisation the App is registered under it (needed to install a
// private App on that organisation); without, under the admin's own account.
export const startGithubAppCreation = async (
  idToken: string,
  organization?: string,
): Promise<void> => {
  const response = await axios.get('/api/setup/github/manifest', {
    ...auth(idToken),
    params: organization ? { organization } : undefined,
  });
  const { action, manifest } = response.data;
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
};
