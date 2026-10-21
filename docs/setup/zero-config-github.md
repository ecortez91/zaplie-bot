# Zero-config GitHub setup (App manifest flow)

Zaplie creates your organisation's GitHub App for you. An admin clicks once,
GitHub shows a single confirmation screen, and every credential (App ID,
private key, webhook secret, OAuth client id and secret) travels from GitHub to
the Zaplie server over the conversion API. Nobody types or copies a secret,
ever.

Reference: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

## How it works

1. **Create** - portal, Automations page, GitHub card: an admin (the
   `Zaplie.Admin` app role) clicks "Create the Zaplie GitHub App". The browser
   form-POSTs a manifest (name, permissions, redirect URL) to
   `github.com/settings/apps/new` with an HMAC-signed `state`.
2. **Confirm** - GitHub shows one pre-filled "Create GitHub App" screen. The
   admin confirms and GitHub redirects to
   `/api/setup/github/callback?code=...&state=...`.
3. **Convert** - the tab backend calls
   `POST https://api.github.com/app-manifests/{code}/conversions` and receives
   the App ID, slug, private key, webhook secret and OAuth client credentials
   in one response. They are persisted server-side in
   `github-app-credentials.json` under `ZAPLIE_DATA_DIR` (owner-only, written
   atomically, gitignored) and never logged or sent to the browser. The admin
   lands back on `/automations?setup=github_created` (or
   `?setup=github_error`), which the page shows as a toast.
4. **Install** - the "Connect repositories" button sends the admin to
   `github.com/apps/{slug}/installations/new?state=...` to pick repositories,
   exactly like Vercel or Linear. The button stays disabled until the App
   exists. GitHub then redirects to the App's setup URL,
   `/api/connections/github/setup?installation_id=...&setup_action=install&state=...`,
   which records the installation against the person in the signed `state`
   and returns to the portal with `?github=repos_connected`. With
   `setup_on_update`, later repository changes come back the same way. A
   change made on GitHub's own settings page carries no state of ours, so it
   records nothing and shows `?github=repos_updated`. An install that an
   organisation owner still has to approve (`setup_action=request`) shows
   `?github=install_requested`.

The conversion code is one-shot and the whole flow must finish within one
hour; a stale or replayed code fails loudly and the admin just clicks the
button again.

## Design notes

- No `GITHUB_*` environment variables are needed. Every GitHub-backed route
  (App JWT, install URL, identity OAuth) reads its configuration through
  `tabs/backend/githubAppConfig.js`.
- Precedence: env first, then the stored manifest credentials, the same rule
  as the internal secrets below. Each group resolves from one source as a
  whole and never mixes the two: the App key (`GITHUB_APP_ID` +
  `GITHUB_APP_PRIVATE_KEY_PATH`), the OAuth client
  (`GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET`) and the slug
  (`GITHUB_APP_SLUG`). A partly set group is ignored in favour of the stored
  one.
- Callback URLs are built from the origin of `PORTAL_URL`, because that
  variable may point at a route such as Settings: the manifest registers
  `<origin>/api/setup/github/callback` and
  `<origin>/api/identities/github/callback` plus the setup URL
  `<origin>/api/connections/github/setup`. With the stored client, the
  identity flow always sends that callback as its `redirect_uri`.
  `GITHUB_OAUTH_REDIRECT_URI` applies only to an env OAuth client (a separate
  OAuth App), since the stored client has nothing else registered.
- A group set entirely in env never reads the credentials file, so a corrupt
  file cannot block it.
- Until the app is created, GitHub-backed endpoints respond
  `409 GitHub app not created yet: an admin can create it from Automations` -
  a clear pointer to the setup button, never a crash or a silent failure.
- `GET /api/setup/github/status` (any signed-in user, non-secret fields only)
  returns `created`, `slug`, `htmlUrl`, `source` and `installationReady`.
  `source` is `env` when the App comes from env vars, `manifest` when it comes
  from the stored credentials, `none` before either exists.
  `installationReady` is true only when both the slug and the App key resolve,
  since listing an installation's repositories needs the key: a
  `GITHUB_APP_SLUG` on its own reports `env` but not ready. Automations
  enables "Connect repositories" only when ready, and shows "configured by
  environment" (no creation click) for a complete env configuration.
- A corrupt credentials file or a `PORTAL_URL` that does not parse fails the
  affected route with a generic error. Neither the file's contents nor the
  parser's message reaches a response.
- The same app authorizes users for identity linking ("Connect GitHub" in
  Settings), so one creation click covers both the org connection and personal
  identity. The manifest sets `request_oauth_on_install: false`: with it on,
  GitHub skips the setup URL after an install and runs its own OAuth flow into
  the identity callback with no `state` and no installation id, so the
  installation was never recorded. Installing the App and linking an identity
  are therefore two separate steps.
- Internal secrets that only Zaplie itself consumes (`IDENTITY_STATE_SECRET`,
  the Nostr org key) are generated with `crypto.randomBytes` on first use and
  persisted server-side (`tabs/backend/secrets.json`, gitignored). They are
  not configuration.
