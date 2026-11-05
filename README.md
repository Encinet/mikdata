# Mik Data

Cloudflare Worker for public Minecraft data, building administration and MikWeb authentication.

- Public API: `https://data.mcmik.top/api` — routes and schemas are in [openapi.yaml](./openapi.yaml). Public reads allow any browser origin; `/health` provides a health check.
- Administration: `/admin` and `/admin/api/*`, protected by Cloudflare Access.
- MikWeb: private `/auth/*` and `/me/*` endpoints called by the BFF. Session identity comes from `X-Mik-Session`; login binding uses `X-Mik-Browser-Nonce`.

## Configuration

All variables are required except the WebAuthn settings, which default to production values.

| Variable | Purpose / default |
|----------|-------------------|
| `MINECRAFT_SERVER_URL` | Upstream base URL reachable through `VPC_SERVICE` |
| `MINECRAFT_SERVER_ADDRESS` | Minecraft status fallback host |
| `MINECRAFT_SERVER_PORT` | Minecraft status fallback port |
| `CLOUDFLARE_ACCESS_ISSUER` | Access issuer, such as `https://your-team.cloudflareaccess.com` |
| `CLOUDFLARE_ACCESS_AUD` | Access application audience for `/admin*` |
| `MIKWEB_AUTH_CLIENT_SECRET` | Shared server-side secret with the MikWeb BFF |
| `WEBAUTHN_RP_ID` | Passkey RP ID; defaults to `mcmik.top` |
| `WEBAUTHN_ORIGIN` | Allowed origins, comma-separated; defaults to `https://mcmik.top` |

The Passkey RP ID must match the MikWeb hostname or a registrable parent domain. For local development, use `WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000`, and run MikData locally alongside MikWeb.

## Development

```sh
bun install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with the configuration above, then run:

```sh
bun run dev
```

Run tests, type checking and a deployment dry-run:

```sh
bun run check
```

## Deployment

Configure the KV namespace, VPC service, domain and rate-limit namespace IDs in [wrangler.jsonc](./wrangler.jsonc). Keep the four rate-limit namespace IDs distinct and preserve the Durable Object migration history.

To create the building KV namespace, run this command and copy its ID into the configuration:

```sh
bunx wrangler kv namespace create BUILDINGS_KV
```

Create a Cloudflare Access application for `data.mcmik.top/admin*`. Set each required variable as a Wrangler secret, then deploy:

```sh
bunx wrangler secret put VARIABLE_NAME
bun run deploy
```

## Data behavior

`AUTH_STORE` uses SQLite for accounts, sessions, buildings, submissions and upload receipts. Public buildings are served from KV snapshots and caches. Publication attempts are spaced at least five minutes apart; KV propagation and cache expiry add visibility delay. A missing public snapshot is rebuilt from SQLite.

A five-minute cron refreshes players, bans and announcements. Community board data stays in the Minecraft plugin. Chat WebSocket traffic goes directly to the plugin through Cloudflare Tunnel; its setup is documented in the plugin's `docs/web-chat.md`.

Building submissions require membership and ImgBB WebP uploads. Accounts may have up to 10 pending submissions; completed reviews remain visible for 14 days. Record expiry does not delete hosted images.
