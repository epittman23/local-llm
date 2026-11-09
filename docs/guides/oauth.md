# OAuth sign-in

OAuth / OIDC sign-in is not in use today: no provider is configured. It is
kept working, and when it is wanted it is turned on through environment
variables only. Admin Settings > Authentication does not configure the
provider (see the 2026-11-08 entry in [../decisions.md](../decisions.md)).

## Why the environment

The backend builds its OAuth providers once, at import (`load_oauth_providers()`
in `apps/server/local_llm/config.py`), from environment variables. Nothing
rebuilds them while it runs, so a provider setting changed in the app could
not take effect, and the form that offered them used to save values nothing
read. Changing a provider variable takes a backend restart.

## Turning it on

Put the variables in `infra/.env`, which `make backend` exports to the
backend (it is gitignored; `cp infra/.env.example infra/.env`), then restart
the backend. The sign-in page then shows a button per configured provider.
The provider's redirect URI is registered with it as
`<backend origin>/oauth/<provider>/callback`, where `<provider>` is `google`,
`microsoft`, `github`, `oidc` or `feishu`, unless the `*_REDIRECT_URI`
variable below says otherwise.

A provider is registered only when its required variables are all set.

### A generic OpenID Connect provider (`oidc`)

Registered when `OAUTH_CLIENT_ID`, `OPENID_PROVIDER_URL` and one of
`OAUTH_CLIENT_SECRET` or `OAUTH_CODE_CHALLENGE_METHOD` are set.

| Variable | What it does | Default |
|---|---|---|
| `OPENID_PROVIDER_URL` | The provider's OpenID discovery document (`.../.well-known/openid-configuration`). Sign-out also reads its `end_session_endpoint`. | none |
| `OAUTH_CLIENT_ID` | Client identifier from the provider. | none |
| `OAUTH_CLIENT_SECRET` | Client secret from the provider. | none |
| `OPENID_REDIRECT_URI` | Callback URI registered with the provider. | derived from the request |
| `OAUTH_SCOPES` | Scopes requested at sign-in. | `openid email profile` |
| `OAUTH_PROVIDER_NAME` | Name on the sign-in button. | `SSO` |
| `OAUTH_CODE_CHALLENGE_METHOD` | `S256` turns on PKCE; any other value stops the backend registering the provider with an error. | none |
| `OAUTH_TOKEN_ENDPOINT_AUTH_METHOD` | Client authentication at the token endpoint (for example `client_secret_post`). | the library's default |
| `OPENID_END_SESSION_ENDPOINT` | A fixed sign-out URL (for example AWS Cognito), used instead of discovering one from the provider. | none |

### The named providers

| Provider | Required | Optional |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `GOOGLE_OAUTH_SCOPE` (`openid email profile`), `GOOGLE_REDIRECT_URI`, `GOOGLE_OAUTH_AUTHORIZE_PARAMS` (a JSON object) |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_CLIENT_TENANT_ID` | `MICROSOFT_OAUTH_SCOPE` (`openid email profile`), `MICROSOFT_REDIRECT_URI`, `MICROSOFT_CLIENT_LOGIN_BASE_URL`, `MICROSOFT_CLIENT_PICTURE_URL` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `GITHUB_CLIENT_SCOPE` (`user:email`), `GITHUB_CLIENT_REDIRECT_URI` |
| Feishu | `FEISHU_CLIENT_ID`, `FEISHU_CLIENT_SECRET` | `FEISHU_OAUTH_SCOPE` (`contact:user.base:readonly`), `FEISHU_REDIRECT_URI` |

For the named providers, set `OPENID_PROVIDER_URL` or
`OPENID_END_SESSION_ENDPOINT` too, or sign-out will not end the provider's
session (the backend logs a warning at startup).

### Behaviour of every provider

| Variable | What it does | Default |
|---|---|---|
| `ENABLE_OAUTH` | Master switch for OAuth sign-in. | `True` |
| `ENABLE_OAUTH_SIGNUP` | Let a first OAuth sign-in create an account. | `False` |
| `OAUTH_MERGE_ACCOUNTS_BY_EMAIL` | Sign an OAuth user in to the existing account with the same email. | `False` |
| `OAUTH_AUTO_REDIRECT` | Send the sign-in page straight to the provider. | `False` |
| `OAUTH_ALLOWED_DOMAINS` | Comma-separated email domains allowed to sign in. | `*` |
| `OAUTH_TIMEOUT`, `OAUTH_CLIENT_TIMEOUT` | Whole seconds for requests to the provider; anything else sets no timeout. | none |
| `OAUTH_EMAIL_CLAIM`, `OAUTH_USERNAME_CLAIM`, `OAUTH_PICTURE_CLAIM`, `OAUTH_SUB_CLAIM` | Which claims hold the email, display name, picture and stable user id. | `email`, `name`, `picture`, the provider's own |
| `OAUTH_AUDIENCE` | Audience sent with the authorization request. | none |
| `OAUTH_UPDATE_EMAIL_ON_LOGIN`, `OAUTH_UPDATE_NAME_ON_LOGIN`, `OAUTH_UPDATE_PICTURE_ON_LOGIN` | Refresh that profile field from the provider at each sign-in. | `False` |
| `OAUTH_REFRESH_TOKEN_INCLUDE_SCOPE` | Include the scope when refreshing a token. | `False` |
| `ENABLE_OAUTH_ROLE_MANAGEMENT` | Map a claim to roles. With it on: `OAUTH_ROLES_CLAIM` (`roles`), `OAUTH_ALLOWED_ROLES` (`user,admin`), `OAUTH_ADMIN_ROLES` (`admin`), `OAUTH_ROLES_SEPARATOR` (`,`). | `False` |
| `ENABLE_OAUTH_GROUP_MANAGEMENT` | Map a claim to groups. With it on: `OAUTH_GROUP_CLAIM` (`groups`), `OAUTH_GROUPS_SEPARATOR` (`;`), `OAUTH_BLOCKED_GROUPS`, `ENABLE_OAUTH_GROUP_CREATION` (create missing groups), `OAUTH_GROUP_DEFAULT_SHARE` (`true`, `false` or `members`). | `False` |

Sign-out redirects to `LLLM_AUTH_SIGNOUT_REDIRECT_URL` when that is set, and
the session tokens OAuth stores are encrypted with
`OAUTH_SESSION_TOKEN_ENCRYPTION_KEY` (default `LLLM_SECRET_KEY`).

## What Admin Settings still shows

With `ENABLE_OAUTH_PERSISTENT_CONFIG` on (it is off by default), the
Authentication page offers the behaviour settings above that the backend reads
for each sign-in (the claims, allowed domains, role and group mapping,
account merging, profile updates, signup and the master switch). With it off,
the page shows them read-only and the environment values apply. The provider
settings in the first two tables are never offered there. Values the old form
saved under the provider keys remain in the `config` table and are not read.

The desktop app additionally needs the provider's origin allowed to navigate
in-app; see [desktop.md](desktop.md).
