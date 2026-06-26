# mikdata

Cloudflare Worker data API for MikWeb.

The Worker is published as `https://data.mcmik.top/api`. It forwards a small allowlisted API surface to the Minecraft data services, stores the last successful JSON payload in KV, and returns stale cached data when the upstream service is unavailable.

## Routes

- `GET /api/players`
- `GET /api/buildings`
- `GET /api/bans`
- `GET /api/announcements`
- `GET /health`

## Security Model

- No arbitrary proxying. Every public route is allowlisted in `src/index.ts`.
- Only `GET` and `OPTIONS` are accepted.
- HMAC secrets are Worker secrets and are only used server-side.
- CORS is restricted by `ALLOWED_ORIGINS`; use comma-separated origins.
- Upstream responses must be successful JSON before being persisted.

## Runtime Configuration

Do not put upstream addresses or secrets in `wrangler.jsonc`. Store all runtime configuration as Cloudflare secrets:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MINECRAFT_SERVER_URL` | Yes | Main upstream data service base URL |
| `BUILDINGS_SERVER_URL` | Yes | Buildings upstream data service base URL |
| `MINECRAFT_SERVER_ADDRESS` | Yes | Minecraft status fallback host |
| `MINECRAFT_SERVER_PORT` | Yes | Minecraft status fallback port |
| `ALLOWED_ORIGINS` | Yes | Comma-separated CORS allowlist |
| `MINECRAFT_HMAC_SECRET` | Yes | HMAC timestamp secret for the main upstream |
| `BUILDINGS_HMAC_SECRET` | Yes | HMAC timestamp secret for the buildings upstream |

The upstream auth token is sent in `X-HMAC-Token`. Its value is an HMAC-SHA256 hex digest of the current 30-second Unix time step.
Minecraft upstream requests use the `VPC_SERVICE` binding configured in `wrangler.jsonc`; `MINECRAFT_SERVER_URL` should be reachable through that VPC service.

```sh
bunx wrangler secret put MINECRAFT_SERVER_URL
bunx wrangler secret put BUILDINGS_SERVER_URL
bunx wrangler secret put MINECRAFT_SERVER_ADDRESS
bunx wrangler secret put MINECRAFT_SERVER_PORT
bunx wrangler secret put ALLOWED_ORIGINS
bunx wrangler secret put MINECRAFT_HMAC_SECRET
bunx wrangler secret put BUILDINGS_HMAC_SECRET
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill values. `.dev.vars` is ignored by git.

## Setup

Install dependencies:

```sh
bun install
```

Create KV namespaces:

```sh
bunx wrangler kv namespace create MIKDATA_CACHE
```

Put the generated `id` into `wrangler.jsonc`.

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
- buildings
- bans
- announcements
