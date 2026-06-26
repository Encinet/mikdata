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
- TOTP secrets are Worker secrets and are only used server-side.
- CORS is restricted by `ALLOWED_ORIGINS`; use comma-separated origins.
- Upstream responses must be successful JSON before being persisted.

## Configuration

Public Worker variables in `wrangler.jsonc`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `MINECRAFT_SERVER_URL` | Yes | Main upstream data service base URL |
| `BUILDINGS_SERVER_URL` | No | Optional buildings upstream; falls back to `MINECRAFT_SERVER_URL` |
| `MINECRAFT_SERVER_ADDRESS` | No | Minecraft status fallback host |
| `MINECRAFT_SERVER_PORT` | No | Minecraft status fallback port, defaults to `25565` |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS allowlist |

Secrets:

```sh
bunx wrangler secret put TOTP_SECRET
bunx wrangler secret put BUILDINGS_TOTP_SECRET
```

`TOTP_SECRET` is required for the main upstream. `BUILDINGS_TOTP_SECRET` only needs to be set when the buildings service uses a different secret.

## Setup

Install dependencies:

```sh
bun install
```

Create KV namespaces:

```sh
bunx wrangler kv namespace create MIKDATA_CACHE
bunx wrangler kv namespace create MIKDATA_CACHE --preview
```

Put the generated `id` and `preview_id` into `wrangler.jsonc`.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill values.

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
