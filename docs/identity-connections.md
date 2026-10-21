# Identity connections

Zaplie routes automated rewards by stable identities rather than display names.
For GitHub, the canonical chain is:

```text
GitHub numeric user id -> linked identity -> Entra oid -> LNbits external_id
```

The GitHub login is stored only as a label. Renaming a GitHub account does not
change reward routing.

## Trust boundaries

- The browser calls `POST /api/identities/github/authorize-url` and
  `GET /api/identities/mine` with its MSAL ID token. The backend validates its
  signature, tenant, audience, and `oid` claim.
- GitHub's client secret, OAuth access token, and `IDENTITY_STATE_SECRET` remain
  in the tab backend. The signed, expiring OAuth state binds the callback to the
  verified Entra `oid` that started the flow.
- The bot calls `GET /api/identities/resolve` with `TAB_BACKEND_TOKEN`. This is a
  server-to-server secret and must never be exposed through a `REACT_APP_*`
  variable or otherwise sent to browser code.
- A linked GitHub numeric id can belong to only one Entra person. Conflicting
  links fail instead of silently reassigning the account.

## Required configuration

Configure these values in the tab backend's approved server-side secret store.
[`tabs/backend/.env.example`](../tabs/backend/.env.example) lists names only.

| Variable | Purpose |
| --- | --- |
| `AAD_TENANT_ID` | Entra tenant accepted by the backend JWT verifier. |
| `AAD_CLIENT_ID` | Audience expected on the portal's MSAL ID token. |
| `GITHUB_OAUTH_CLIENT_ID` | Optional. GitHub OAuth client id; when unset, the client of the App created from Automations is used. |
| `GITHUB_OAUTH_CLIENT_SECRET` | Optional, set together with the client id. Server only. |
| `GITHUB_OAUTH_REDIRECT_URI` | Optional, and used only with the env client above. Defaults to `<PORTAL_URL origin>/api/identities/github/callback`, the callback the App manifest registers. Set it only when a separate OAuth App registered a different URL. The stored App client always uses the manifest callback. |
| `IDENTITY_STATE_SECRET` | Random secret used to sign the expiring OAuth state. |
| `PORTAL_URL` | Portal URL that receives the `?github=connected`, `conflict`, or `error` result. Its origin is also where the GitHub callbacks are registered. |
| `TAB_BACKEND_TOKEN` | Shared server-to-server token expected from the bot. Generate independently with `openssl rand -hex 32`. |

Configure these values on the bot process:

| Variable | Purpose |
| --- | --- |
| `WEBSITE_API_URL` | Tab backend API base URL, including `/api`. Required in production. |
| `TAB_BACKEND_TOKEN` | The same server-to-server value configured on the tab backend. |
| `LNBITS_NODE_URL` | LNbits base URL. |
| `LNBITS_USERNAME` / `LNBITS_PASSWORD` | LNbits service credentials used to obtain the admin bearer token. |
| `LNBITS_ADMINKEY` | Required guard for the linked-user lookup and wallet access. |

Do not reuse `REWARDS_API_KEY` as `TAB_BACKEND_TOKEN`; the external automation
boundary and the internal bot-to-backend boundary have different exposure and
rotation needs. Missing values and the old `your-secret-token` placeholder are
configuration errors, not development fallbacks.

## GitHub OAuth setup

1. Set `PORTAL_URL` to the portal Settings route for that environment.
2. An admin creates the Zaplie GitHub App from Automations
   ([zero-config setup](setup/zero-config-github.md)). Its OAuth client
   serves "Connect GitHub" with no further configuration.
3. Provision the Entra values in the backend secret store.
4. Provision the same newly generated `TAB_BACKEND_TOKEN` on the bot and tab
   backend, then restart both processes.

To use a separate GitHub OAuth App instead, set `GITHUB_OAUTH_CLIENT_ID` and
`GITHUB_OAUTH_CLIENT_SECRET` (env wins over the stored App credentials) and
register `<PORTAL_URL origin>/api/identities/github/callback` as its callback,
or set `GITHUB_OAUTH_REDIRECT_URI` to the URL it registers.

The same OAuth client also verifies repository installs. Before saving an
installation, "Connect repositories" asks the person to authorize the App and
checks `GET /user/installations` with that user token. The check needs a
GitHub App user token, so env OAuth credentials that belong to a separate
OAuth App break that step. To keep it working, use the GitHub App's own
client and register `<PORTAL_URL origin>/api/connections/github/verify` as
another callback URL.

Identity and pending-reward JSON stores are runtime data and are gitignored.
Do not copy production identity data into the repository or screenshots.

## Known readiness dependency

`TAB_BACKEND_TOKEN` protects the server-to-server routes
(`GET /api/identities/resolve`, `POST /api/pending-rewards`) and is also
accepted, as an alternative to a verified MSAL token, on the config reads
guarded by `requireSignedInOrBot` (`GET /api/automations`,
`GET /api/reward-amounts`).

Nothing binds the token to server-side callers: `authMiddleware` and
`requireSignedInOrBot` authorize any HTTP client that presents the value in the
`Authorization` header, including a browser. The token is a full bearer
credential for those routes, not a server-only secret by construction; keeping
it out of browsers is an operational obligation. Never expose it through a
`REACT_APP_*` variable, client code, logs, or screenshots, and rotate it
immediately if it reaches any of those.

Administrative writes (`POST /api/automations`, `POST /api/reward-amounts`,
`POST /api/reward-name`) do not accept the shared token: they require a
verified MSAL ID token whose account carries the `Zaplie.Admin` app role.

## Verification

From a Node.js 24 checkout:

```bash
npx jest --ci --runInBand src/services/internalAuth.test.ts src/services/identityService.test.ts src/services/pendingRewardsService.test.ts

cd tabs
npm run test:backend
```

Then exercise the real Settings flow: verify loading and error states, connect a
GitHub account, refresh to confirm the linked handle, and confirm a conflicting
link cannot be reassigned. Finally, call the internal resolve route with a wrong
token (expect `401`) and with the configured server token (expect the linked
`personAad`; never log either token).
