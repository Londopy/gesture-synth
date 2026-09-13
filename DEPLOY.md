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
npm ci && node scripts/fetch-models.mjs && npm run build
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
Windows (`.msi`, setup `.exe`) and Linux (`.deb`, `.AppImage`) bundles with
Tauri, a zip of the web build with a local server, `SHA256SUMS.txt`, and
release notes rendered from `CHANGELOG.md`, then publishes the GitHub Release.
GitHub Actions is free for public repositories. Every job has a
`timeout-minutes` so a stuck runner cannot burn the monthly quota.

macOS is not part of the automatic release: hosted macOS runners have hung
without finishing for this project. There is an opt-in workflow instead,
**Actions › macOS build (opt-in) › Run workflow**: enter the release tag, tick
"intel" if you also want an x86_64 build. It uses an Apple Silicon runner,
builds arm64 only (no universal lipo), pulls ffmpeg from `ffmpeg-static`
instead of Homebrew, has a 45-minute timeout, and attaches the `.dmg` plus
its checksum to the release. If it still hangs, build on a Mac:

```bash
xcode-select --install
npm install && npm run models && npm run tauri:build      # src-tauri/target/release/bundle/dmg/
shasum -a 256 src-tauri/target/release/bundle/dmg/*.dmg   # append to SHA256SUMS.txt
```
