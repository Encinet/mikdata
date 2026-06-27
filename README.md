# Mik Data

Cloudflare Worker data API for MikWeb.

The Worker is published as `https://data.mcmik.top/api`. It forwards a small allowlisted API surface to the Minecraft data service and caches public JSON responses with the Worker Cache API. Buildings are persisted in Worker KV, while the public buildings summary is served from memory/Worker Cache with a Durable Object snapshot fallback.

Public API details are documented in `openapi.yaml`.

## Routes

Public API:

- `GET /api/players`
- `GET /api/buildings`
- `GET /api/buildings/:id`
- `GET /api/bans`
- `GET /api/announcements`
- `GET /health`

Admin UI and write API:

- `GET /admin`
- `POST /admin/api/buildings`
- `PUT /admin/api/buildings/:id`
- `PATCH /admin/api/buildings/:id`
- `DELETE /admin/api/buildings/:id`
- `POST /admin/api/buildings/import`

## Security Model

- No arbitrary proxying. Every public route is allowlisted in `src/index.ts`.
- Public API routes only accept `GET` and `OPTIONS`.
- Buildings read routes are public `GET` routes.
- Public API routes allow browser requests from any origin.
- Admin routes live under `/admin*` and require Cloudflare Access. The Worker validates the Access JWT issuer and AUD before serving any `/admin*` response.
- Buildings write routes reject cross-site browser requests and do not expose CORS preflight headers.
- `/admin/api` is not listed in `openapi.yaml`. Treat it as an operational interface, not as a public API contract.
- `workers_dev` is disabled so the Worker is intended to be reached through the configured custom domain only.
- Upstream responses must be successful JSON before being persisted.
- Building writes are serialized through the `BUILDINGS_WRITER` Durable Object.
- Building mutations write audit logs with action, building id, and Cloudflare Access identity. Payloads are not logged.
- Building image URLs must be relative paths or `https://` URLs.

Configure a Cloudflare Access self-hosted application for `data.mcmik.top/admin*`. The Worker checks `Cf-Access-Jwt-Assertion`, so `X-Admin-Token` is not used.

To find the Access settings:

- `CLOUDFLARE_ACCESS_ISSUER`: Zero Trust team domain, for example `https://your-team.cloudflareaccess.com`.
- `CLOUDFLARE_ACCESS_AUD`: Access application AUD tag from the application page.

## Runtime Configuration

Do not put upstream addresses or secrets in `wrangler.jsonc`. Store all runtime configuration as Cloudflare secrets:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MINECRAFT_SERVER_URL` | Yes | Main upstream data service base URL |
| `MINECRAFT_SERVER_ADDRESS` | Yes | Minecraft status fallback host |
| `MINECRAFT_SERVER_PORT` | Yes | Minecraft status fallback port |
| `CLOUDFLARE_ACCESS_ISSUER` | Yes | Access issuer, for example `https://your-team.cloudflareaccess.com` |
| `CLOUDFLARE_ACCESS_AUD` | Yes | Access application AUD tag for `/admin*` |
| `MIKWEB_AUTH_CLIENT_SECRET` | Yes | Shared server-side secret for MikWeb `/api/auth/*` and `/api/account/*` BFF requests |

Minecraft upstream requests use the `VPC_SERVICE` binding configured in `wrangler.jsonc`; `MINECRAFT_SERVER_URL` should be reachable through that VPC service.
Buildings require the `BUILDINGS_KV` binding and `BUILDINGS_WRITER` Durable Object binding.

```sh
bunx wrangler secret put MINECRAFT_SERVER_URL
bunx wrangler secret put MINECRAFT_SERVER_ADDRESS
bunx wrangler secret put MINECRAFT_SERVER_PORT
bunx wrangler secret put CLOUDFLARE_ACCESS_ISSUER
bunx wrangler secret put CLOUDFLARE_ACCESS_AUD
bunx wrangler secret put MIKWEB_AUTH_CLIENT_SECRET
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill values. `.dev.vars` is ignored by git.

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

The first deployment also applies the `BuildingsWriter` Durable Object migration from `wrangler.jsonc`.

Run locally:

```sh
bun run dev
```

Deploy:

```sh
bun run deploy
```

## Refresh Behavior

Cloudflare Cron refreshes stable routes every five minutes:

- players
- bans
- announcements
