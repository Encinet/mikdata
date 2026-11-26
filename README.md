# Mik Data

Cloudflare Worker for public Minecraft data, building administration and MikWeb authentication.

- Public API at `https://data.mcmik.top/api` ([OpenAPI](./openapi.yaml)) and health check at `/health`.
- Building administration at `/admin` and `/admin/api/*` behind Cloudflare Access.
- Private `/auth/*` and `/me/*` routes for the MikWeb BFF.

Players, authentication, buildings and sponsors run in one Worker and share one D1 database.

## Development

```sh
bun install
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`, then run `bun run dev` with an initialized local D1 database. For local MikWeb passkeys, set `WEBAUTHN_RP_ID=localhost` and `WEBAUTHN_ORIGIN=http://localhost:3000`.

Run `bun run check` for tests, type checking and a deployment dry run.

## Deployment

1. Set the VPC service, domain and distinct rate-limit namespace IDs in [wrangler.jsonc](./wrangler.jsonc).
2. Create a Cloudflare Access application for `data.mcmik.top/admin*`. Set Worker variables from [.dev.vars.example](./.dev.vars.example) and use `bunx wrangler secret put VARIABLE_NAME` for secrets.
3. Point the `DB` binding at the existing D1 database for the environment.
4. Run `bun run check`, then `bun run deploy`.

## Buildings

The S3 credentials need read, write and delete access under `buildings/`. The public image base URL defaults to the bucket URL.

Upload and reorder images in the admin editor. The first image is the cover. For JSON imports, omit `id`, use `"images": []`, and add files in the editor afterward.

The player and admin browsers resize the longest edge to at most 3840 pixels and encode WebP and progressive JPEG XL originals within a combined 4 MiB. They also upload a WebP thumbnail of at most 800 pixels on the longest edge and 128 KiB. The Worker validates the files and hashes and reads the JXL section offsets. Catalog images contain the `webp`, `jxl` and `thumbnailWebp` digests plus `jxlPreviewBytes`. A zero byte budget selects the thumbnail. Storage serves each object directly at `{imageBaseUrl}/buildings/{id}/{digest}.{format}`; thumbnails use the WebP extension. For resumable covers, allow cross-origin GET requests with a single HTTP byte range.

Each member account can have 10 pending submissions. Completed reviews stay visible for 14 days. Unused uploads expire after 24 hours. The image collector waits 14 days after it first finds an object with no references.

Public building responses are cached at the edge for 60 seconds. On a cache miss, detail requests query D1 by ID. List requests can use `limit` and `offset` to page through the filtered results.

## Sponsors

`GET /api/sponsors` lists sponsors by Minecraft UUID with their totals and individual paid orders, including any messages. Order timestamps are UTC date-time strings. Set `AFDIAN_USER_ID` and `AFDIAN_API_TOKEN` to enable Afdian. The Worker checks whether a sync is due at the top of each UTC hour. After a successful sync, the next sync is due six hours later.

Use `/admin/sponsors` to view orders, manage manual payments, and bind Afdian accounts to Minecraft UUIDs.
