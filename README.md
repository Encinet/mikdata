# Mik Data

Cloudflare Worker for public Minecraft data, building administration and MikWeb authentication. Public API: `https://data.mcmik.top/api`; schema: [openapi.yaml](./openapi.yaml).

## Routes

Public API:

- `GET /api/players`
- `GET /api/buildings`
- `GET /api/buildings/:id`
- `GET /api/bans`
- `GET /api/announcements`
- `GET /api/community/notices`
- `GET /api/community/notices/:id`
- `GET /health`

Admin UI and write API:

- `GET /admin`
- `POST /admin/api/buildings`
- `PUT /admin/api/buildings/:id`
- `PATCH /admin/api/buildings/:id`
- `DELETE /admin/api/buildings/:id`
- `POST /admin/api/buildings/import`
- `GET /admin/api/building-submissions`
- `PUT /admin/api/building-submissions/:id`
- `PUT /admin/api/building-submissions/:id/approve`
- `PUT /admin/api/building-submissions/:id/reject`

Private MikWeb endpoints use `/auth/*` and `/me/*` and require `MIKWEB_AUTH_CLIENT_SECRET`. The BFF supplies session authority through `X-Mik-Session` and login binding through `X-Mik-Browser-Nonce`; JSON bodies carry operation inputs.

## Security and storage

- Public routes accept `GET` and `OPTIONS`, allow any browser origin, and use an explicit route allowlist.
- `/admin*` requires a Cloudflare Access JWT with the configured issuer and audience. Configure an Access application for `data.mcmik.top/admin*`; admin writes reject cross-site requests.
- Account operations derive identity from the server session. Auth and admin JSON request bodies are limited to 64 KiB.
- `AUTH_STORE` stores credentials, sessions, buildings, submissions and upload receipts in SQLite. Building writes and approvals use transactions.
- Public building reads use a KV snapshot and caches. Snapshot publication is coalesced to at most one attempt every five minutes; public updates also depend on KV propagation and cache expiry.
- Building coordinates contain `world`, `x`, `y` and `z`. The first building operation automatically imports existing KV records into SQL, using `world` for missing world names. The isolated migration commits once, preserves source KV records and never reimports a deleted building. A missing public snapshot is rebuilt from SQL.
- Building submissions require a member account and ImgBB WebP uploads. Each account may have 10 pending submissions; completed reviews remain visible for 14 days. Expiry does not delete hosted images.
- Unknown auth routes are rejected before accessing storage. Rate limiter failures return `503`; limiter bindings do not enforce a global billing quota.

Rate limits per 60 seconds:

| Requests | Limit | Key |
|----------|-------|-----|
| Public data | 120 | Client IP |
| Minecraft challenge creation | 8 | Client key |
| Challenge completion and Passkey login | 20 | Action and client key |
| Passkey registration options | 8 | Session |
| Passkey and session naming | 20 | Account |
| All auth requests | 60 | Client key |

## Login and chat

Login supports Minecraft codes and discoverable Passkeys. The plugin verifies current membership; sessions expire after 30 days idle or 90 days absolute. Passkeys and sessions are managed at `https://mcmik.top/account/security`. Sensitive changes require authentication within the last five minutes. Settings reauthenticate in place with an existing Passkey or in-game confirmation; successful reauthentication rotates the current session. Registration challenges are session-bound, single-use, and independently valid for five minutes. Authentication and sensitive writes refresh plugin account policy; ordinary reads retain the existing cache.

`PATCH /auth/passkeys/:id` and `PATCH /me/sessions/:id` update an account-owned display name (up to 64 characters; empty resets it). Names are display metadata and do not refresh authentication. Session names survive reauthentication.

`POST /me/chat/authorize` authorizes the browser's WebSocket connection through the private VPC service. Chat messages travel directly to the plugin through Cloudflare Tunnel; history stays in the browser. Tunnel configuration is documented in the mik plugin's `docs/web-chat.md`.

## Runtime Configuration

Set runtime configuration with Wrangler secrets:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MINECRAFT_SERVER_URL` | Yes | Main upstream data service base URL |
| `MINECRAFT_SERVER_ADDRESS` | Yes | Minecraft status fallback host |
| `MINECRAFT_SERVER_PORT` | Yes | Minecraft status fallback port |
| `CLOUDFLARE_ACCESS_ISSUER` | Yes | Access issuer, for example `https://your-team.cloudflareaccess.com` |
| `CLOUDFLARE_ACCESS_AUD` | Yes | Access application AUD tag for `/admin*` |
| `MIKWEB_AUTH_CLIENT_SECRET` | Yes | Shared server-side secret for MikWeb `/api/auth/*` and `/api/account/*` BFF requests |
| `WEBAUTHN_RP_ID` | No | Passkey RP ID, defaults to `mcmik.top`. It must match the MikWeb hostname or a registrable parent domain |
| `WEBAUTHN_ORIGIN` | No | Allowed Passkey origins, defaults to `https://mcmik.top`. Use comma-separated values for multiple origins |

Set `MINECRAFT_SERVER_URL` to an address reachable through the `VPC_SERVICE` binding. Keep the four rate-limit namespace IDs in `wrangler.jsonc` distinct.

Passkey registration and login must happen on an origin compatible with `WEBAUTHN_RP_ID`. Production should use `WEBAUTHN_RP_ID=mcmik.top` and `WEBAUTHN_ORIGIN=https://mcmik.top`. For local MikWeb development, run MikData locally too and set `WEBAUTHN_RP_ID=localhost` with `WEBAUTHN_ORIGIN=http://localhost:3000`.

For each required variable, run:

```sh
bunx wrangler secret put VARIABLE_NAME
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill values. `.dev.vars` is ignored by git.

Community board records and recipient UUIDs are stored by the Minecraft plugin. MikData forwards only the public read endpoints through `VPC_SERVICE`; it does not store board records or accept board writes.

## Setup

Install dependencies:

```sh
bun install
```

Create KV namespaces:

```sh
bunx wrangler kv namespace create BUILDINGS_KV
```

Put the generated `id` values into `wrangler.jsonc`.

Preserve the Durable Object migration history in `wrangler.jsonc` when deploying.

Run locally:

```sh
bun run dev
```

Deploy:

```sh
bun run deploy
```

## Refresh Behavior

Cloudflare Cron refreshes players, bans and announcements every five minutes.
