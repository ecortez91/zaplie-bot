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
   `/api/connections/github/setup?installation_id=...&setup_action=install&state=...`.
5. **Verify** - GitHub documents that a setup URL's `installation_id` can be
   spoofed, so the setup route saves nothing yet. It sends the person through
   the App's user authorization (`github.com/login/oauth/authorize`, with the
   App's OAuth client and a new signed state binding their oid to that
   installation id). GitHub returns to `/api/connections/github/verify`,
   which exchanges the code for a user token and pages through
   `GET /user/installations`. It records the installation only if that user
   can access it, then returns to the portal with `?github=repos_connected`.
   The user token serves that one lookup and is never stored, logged or sent
   to the browser. A failed exchange or lookup, a missing installation or a
   tampered state returns `?github=install_error`.

With `setup_on_update`, GitHub also redirects to the setup URL after a
repository change made on its own settings page. That redirect carries no
state of ours, so it records nothing and shows `?github=repos_updated`. An
install that an organisation owner still has to approve
(`setup_action=request`) shows `?github=install_requested`.

The conversion code is one-shot and the whole flow must finish within one
hour; a stale or replayed code fails loudly and the admin just clicks the
button again.

## Apps created from the earlier manifest

The earlier manifest registered only the identity callback, set no setup URL
and turned on "Request user authorization (OAuth) during installation". An
App created from it never returns to the setup URL, so it cannot connect
repositories. In that App's settings on GitHub (Settings > Developer settings
> GitHub Apps > the Zaplie App):

1. Add `<origin>/api/connections/github/verify` under "Callback URL", keeping
   `<origin>/api/identities/github/callback` as the first entry.
2. Set "Setup URL" to `<origin>/api/connections/github/setup` and enable
   "Redirect on update".
3. Disable "Request user authorization (OAuth) during installation".

Alternatively, delete the App on GitHub, remove `github-app-credentials.json`
from `ZAPLIE_DATA_DIR`, and create it again from Automations. If no App was
created before this change (true for production today), nothing needs doing.

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
  `<origin>/api/setup/github/callback`, the callback URLs
  `<origin>/api/identities/github/callback` (identity linking, listed first)
  and `<origin>/api/connections/github/verify` (install ownership check), and
  the setup URL `<origin>/api/connections/github/setup`. With the stored
  client, the
  identity flow always sends that callback as its `redirect_uri`.
  `GITHUB_OAUTH_REDIRECT_URI` applies only to an env OAuth client (a separate
  OAuth App), since the stored client has nothing else registered.
- The install ownership check needs a GitHub App user token:
  `/user/installations` does not accept OAuth App tokens. With env OAuth
  credentials, they must therefore be the GitHub App's own client, with
  `<origin>/api/connections/github/verify` registered as a callback URL.
  Otherwise "Connect repositories" ends in `install_error`.
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
