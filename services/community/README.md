# Gesture Synth — Community service

A small HTTP/JSON backend (Gleam on the BEAM) for sharing songs, tutorials,
presets, themes and loops between Gesture Synth users: accounts, publishing,
remix chains, likes, comments and short share links.

- **HTTP:** [wisp](https://hex.pm/packages/wisp) on [mist](https://hex.pm/packages/mist)
- **JSON:** gleam_json
- **Storage:** a `Store` record-of-functions interface with two backends:
  - `community/store/memory` — actor-backed in-memory store (tests, dev mode)
  - `community/store/postgres` — [pog](https://hex.pm/packages/pog) + SQL (`sql/schema.sql`)
- **Auth:** bearer tokens (32 random bytes, base64url), stored as SHA-256 digests.
  Passwords are hashed with PBKDF2-HMAC-SHA256 (100 000 iterations, 16-byte
  random salt, constant-time compare) implemented on top of `gleam_crypto` —
  no native NIF dependencies.

## Requirements

- Gleam 1.18+ and Erlang/OTP 27+ (OTP 29 tested)
- Optional: PostgreSQL 14+ for persistent storage

## Running

### Memory mode (no database)

```sh
cd services/community
gleam run
# community: store=memory frontend_origin=http://localhost:5173 cors_origin=*
# Listening on http://0.0.0.0:8787
```

Data lives in the VM and is lost on restart. This is the mode used by the
test suite.

### Postgres mode

```sh
createdb gesture_synth_community

DATABASE_URL=postgres://user:pass@localhost:5432/gesture_synth_community gleam run
# community: store=postgres ...
# community: database schema checked (15 statements)
```

(On PowerShell: `$env:DATABASE_URL = "postgres://..."; gleam run`.)

On startup the service waits for the pool to connect (10 s), then applies
`sql/schema.sql` from the working directory; the file is idempotent so this
is safe on every boot. Hosted connection strings (Neon, Supabase, Render) are
normalised: a missing port becomes `:5432`, and a missing `sslmode` or
`sslmode=require` becomes `sslmode=verify-full` on non-local hosts, because
pog only sends the TLS server name (SNI) when verifying and Neon routes on it.
For `*.neon.tech` hosts the endpoint id is also passed as
`options=endpoint=<id>`, Neon's fallback for clients without SNI.
To manage the schema yourself, run `psql "$DATABASE_URL" -f sql/schema.sql`
and start the service from a directory without `sql/`.

### Tests

```sh
gleam build
gleam test
```

Tests drive the real router end-to-end against the memory store using
`wisp/simulate` (wisp 2.x's name for its testing helpers).

## Configuration (environment variables)

| Variable          | Default                  | Purpose                                                           |
| ----------------- | ------------------------ | ----------------------------------------------------------------- |
| `PORT`            | `8787`                   | TCP port to listen on (binds `0.0.0.0`)                           |
| `DATABASE_URL`    | _(unset)_                | `postgres://user:pass@host:port/db`. Unset → in-memory store      |
| `FRONTEND_ORIGIN` | `http://localhost:5173`  | Where `/s/:code` redirects: `FRONTEND_ORIGIN/<kind>/<item_id>`    |
| `CORS_ORIGIN`     | `*`                      | Value of `Access-Control-Allow-Origin`                            |
| `SECRET_KEY_BASE` | _(random per start)_     | wisp signing secret (≥ 64 bytes; shorter values are SHA-512 stretched) |

Every response carries CORS headers plus
`Cross-Origin-Resource-Policy: cross-origin`, so a frontend served with
`Cross-Origin-Embedder-Policy: require-corp` can fetch from this service.
`OPTIONS` preflights are answered with `204`.

## API

All request and response bodies are JSON with `snake_case` keys. Errors are
`{ "error": "message" }` with an appropriate status (400, 401, 403, 404, 405,
409, 413, 500). Authenticated endpoints take `Authorization: Bearer <token>`.

| Method   | Path                   | Auth   | Description                                                     |
| -------- | ---------------------- | ------ | --------------------------------------------------------------- |
| `GET`    | `/health`              | –      | `{ ok: true, store: "memory" \| "postgres" }`                   |
| `POST`   | `/auth/register`       | –      | `{ handle, display_name, password }` → `201 { token, user }`    |
| `POST`   | `/auth/login`          | –      | `{ handle, password }` → `{ token, user }`                      |
| `POST`   | `/auth/logout`         | yes    | Revokes the current token → `204`                               |
| `GET`    | `/me`                  | yes    | Current user                                                    |
| `GET`    | `/items`               | –      | List; see query params below → `{ items, page, per_page, total }` |
| `POST`   | `/items`               | yes    | `{ kind, title, description?, tags?, payload, parent_id? }` → `201 item` |
| `GET`    | `/items/:id`           | –      | Item with embedded `author { id, handle, display_name }` and `parent { id, title } \| null` |
| `PATCH`  | `/items/:id`           | author | `{ title?, description?, tags?, payload? }` → item              |
| `DELETE` | `/items/:id`           | author | → `204` (likes/comments/share link removed; children detached)  |
| `GET`    | `/items/:id/remixes`   | –      | `{ items: [...] }` — items whose `parent_id` is `:id`           |
| `GET`    | `/items/:id/chain`     | –      | `{ chain: [...] }` — root first, ending with `:id`, max 50      |
| `POST`   | `/items/:id/like`      | yes    | `{ liked: true, like_count }` (idempotent)                      |
| `DELETE` | `/items/:id/like`      | yes    | `{ liked: false, like_count }` (idempotent)                     |
| `GET`    | `/items/:id/comments`  | –      | `{ comments: [...] }`, oldest first, each with `author`         |
| `POST`   | `/items/:id/comments`  | yes    | `{ body }` (1–2000 chars) → `201 comment`                       |
| `DELETE` | `/comments/:id`        | author | → `204`                                                         |
| `POST`   | `/items/:id/share`     | –      | `{ code, url }` — creates or returns the item's 6-char code     |
| `GET`    | `/s/:code`             | –      | `302` → `FRONTEND_ORIGIN/<kind>/<item_id>`                      |

### `GET /items` query parameters

| Param      | Values                                   | Notes                                             |
| ---------- | ---------------------------------------- | ------------------------------------------------- |
| `kind`     | `song` `tutorial` `preset` `theme` `loop` | exact match                                       |
| `q`        | free text                                | case-insensitive substring on title or description |
| `tag`      | tag                                      | exact match (tags are stored lowercase)           |
| `author`   | user id                                  |                                                   |
| `sort`     | `new` (default) or `top`                 | `top` orders by `like_count`, then newest         |
| `page`     | ≥ 1, default 1                           |                                                   |
| `per_page` | 1–100, default 20                        |                                                   |

### Validation rules

- `handle`: 3–24 chars of `[a-z0-9_]` (input is lowercased), unique
- `display_name`: 1–64 chars; `password`: 8–128 chars
- `kind`: one of the five kinds; `title`: 1–120 chars; `description`: ≤ 2000 chars
- `tags`: ≤ 20, each 1–32 chars, lowercased and de-duplicated
- `payload`: any JSON value, ≤ 2 MB of JSON text (request bodies above ~2.06 MB → `413`)
- `parent_id`: must reference an existing item

### Domain shapes

```jsonc
// user
{ "id": "aB3dE5fG7h", "handle": "alice", "display_name": "Alice", "created_at": "2026-09-12T18:04:11.123Z" }

// item
{
  "id": "kL9mN1oP2q", "kind": "song", "title": "Sunrise Groove",
  "description": "…", "author_id": "aB3dE5fG7h",
  "author": { "id": "aB3dE5fG7h", "handle": "alice", "display_name": "Alice" },
  "tags": ["lofi", "chill"], "payload": { /* opaque */ },
  "parent_id": null, "parent": null,
  "like_count": 0, "comment_count": 0,
  "created_at": "…", "updated_at": "…"
}

// comment
{ "id": "…", "item_id": "…", "author_id": "…", "author": { … }, "body": "Nice!", "created_at": "…" }
```

## curl examples

```sh
BASE=http://localhost:8787

curl $BASE/health

# Register (returns a token) and keep it
TOKEN=$(curl -s -X POST $BASE/auth/register \
  -H 'content-type: application/json' \
  -d '{"handle":"alice","display_name":"Alice","password":"correct horse battery"}' \
  | jq -r .token)

curl -H "authorization: Bearer $TOKEN" $BASE/me

# Publish a song
ITEM=$(curl -s -X POST $BASE/items \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"song","title":"Sunrise Groove","description":"Morning loop",
       "tags":["lofi","chill"],"payload":{"bpm":84,"tracks":[]}}' | jq -r .id)

# Remix it
curl -s -X POST $BASE/items \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"kind\":\"song\",\"title\":\"Sunrise Groove (remix)\",\"payload\":{},\"parent_id\":\"$ITEM\"}"

# Browse
curl "$BASE/items?kind=song&q=sunrise&sort=top&page=1&per_page=10"
curl $BASE/items/$ITEM
curl $BASE/items/$ITEM/remixes
curl $BASE/items/$ITEM/chain

# Edit / delete (author only)
curl -X PATCH $BASE/items/$ITEM -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"Sunrise Groove v2"}'

# Like / unlike
curl -X POST   $BASE/items/$ITEM/like -H "authorization: Bearer $TOKEN"
curl -X DELETE $BASE/items/$ITEM/like -H "authorization: Bearer $TOKEN"

# Comments
curl -X POST $BASE/items/$ITEM/comments -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"body":"Lovely pad sound"}'
curl $BASE/items/$ITEM/comments

# Share link -> { "code": "q7Zx2k", "url": "http://localhost:8787/s/q7Zx2k" }
curl -X POST $BASE/items/$ITEM/share
curl -i $BASE/s/q7Zx2k        # 302 Location: http://localhost:5173/song/<id>

curl -X POST $BASE/auth/logout -H "authorization: Bearer $TOKEN"
```

## Project layout

```
src/community.gleam                 main: config, store selection, mist server
src/community/router.gleam          routes + CORS/CORP middleware
src/community/web.gleam             Context, AppError, JSON responses, body parsing
src/community/auth.gleam            PBKDF2 hashing, bearer tokens, /auth/*, /me
src/community/items.gleam           /items CRUD, list/filter/sort, remixes, chain
src/community/comments.gleam        comments
src/community/likes.gleam           likes
src/community/share.gleam           short links + redirect
src/community/json_codec.gleam      encoders + request decoders
src/community/ids.gleam             random IDs / codes / tokens
src/community/config.gleam          environment configuration
src/community/store.gleam           domain types + Store interface
src/community/store/memory.gleam    actor-backed in-memory store
src/community/store/postgres.gleam  pog-backed store
src/community_ffi.erl               tiny Erlang helpers for opaque JSON payloads
sql/schema.sql                      Postgres schema
test/community_test.gleam           end-to-end tests (gleeunit + wisp/simulate)
```

## Notes and limitations

- Sessions never expire on their own; clients call `/auth/logout`. Add a
  `created_at`-based sweep if needed (the column is there).
- The Postgres backend compiles and follows pog 4's API but has not been run
  against a live database in this environment (none was available).
- `GET /items?q=` uses `ILIKE '%…%'`; for large tables enable `pg_trgm` and the
  commented indexes in `sql/schema.sql`.
- Request bodies are parsed as JSON regardless of `Content-Type`.
- There is no rate limiting; put the service behind a reverse proxy that
  provides it, and set `CORS_ORIGIN` to the frontend origin in production.
