# Deploying for free

The web app is a static bundle and the community API is one small BEAM
process, so both fit free tiers.

## Web app (pick one)

| Host | Free tier | COOP/COEP headers (SharedArrayBuffer) | Setup |
| --- | --- | --- | --- |
| **Cloudflare Pages** | unlimited bandwidth | yes, via `app/public/_headers` (already in repo) | connect repo, build `npm run build`, output `app/dist` |
| **Netlify** | 100 GB/month | yes, via `app/public/_headers` | same |
| **Vercel** | 100 GB/month | yes, via `app/vercel.json` | root directory `.`, output `app/dist` |
| **Render** static site | 100 GB/month | yes, via `render.yaml` | "New Blueprint" from this repo |
| **GitHub Pages** | 100 GB/month | **no** custom headers | works, but without SharedArrayBuffer: one camera frame more latency, webm-only export |

The build needs Rust with the `wasm32-unknown-unknown` target and Node 20+.
Cloudflare Pages and Netlify build images already ship Rust; on Render the
blueprint installs it. Build command:

```bash
npm ci --ignore-scripts && node scripts/fetch-models.mjs && npm run build
```

Set `VITE_COMMUNITY_URL` to your API URL before building so the Community
page points at it (users can also change it in Settings).

Every deploy is a plain SPA: `/`, `/loop/<id>`, `/song/<id>`, `/learn/<id>`,
`/preset/<id>` must all rewrite to `index.html` (the config files do this).

## Community API

The Gleam service runs from `services/community/Dockerfile`.

- **Render** (free web service): `render.yaml` at the repo root creates it. Free instances spin down after 15 minutes idle and take ~30 s to wake; the in-memory store loses everything on restart, so add `DATABASE_URL`.
- **Fly.io** (free allowance): `fly launch --dockerfile services/community/Dockerfile`, then `fly secrets set SECRET_KEY_BASE=... DATABASE_URL=...`.
- **Koyeb / Railway** also take the Dockerfile directly.

Free Postgres for `DATABASE_URL`: [Neon](https://neon.tech) or
[Supabase](https://supabase.com). Run `sql/schema.sql` once against it.

Required env: `PORT`, `FRONTEND_ORIGIN` (where `/s/<code>` short links
redirect), `CORS_ORIGIN` (set it to the app origin, not `*`, in production),
`SECRET_KEY_BASE`. The API must send `Cross-Origin-Resource-Policy: cross-origin`
(it does) so the isolated app can fetch it.

## Desktop installers

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`, which builds
Windows (`.msi`, `.exe`), macOS (`.dmg`, universal) and Linux (`.deb`,
`.AppImage`) bundles with Tauri and attaches them to a draft GitHub Release,
plus a zip of the web build. GitHub Actions is free for public repositories.
