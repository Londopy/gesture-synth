//// Postgres `Store` implementation built on `pog`.
////
//// Schema: see `sql/schema.sql`, which is applied at startup when the file is
//// present next to the running service (every statement is `IF NOT EXISTS`, so
//// this is safe to repeat). Used when `DATABASE_URL` is set. This module
//// compiles without a database; it is only exercised at runtime.

import community/store.{
  type Comment, type Item, type ItemQuery, type Page, type Score, type Session,
  type ShortLink, type Store, type StoreError, type User, Comment, Conflict,
  Item, NotFound, Page, Score, Session, ShortLink, Store, Unavailable, User,
}
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/int
import gleam/io
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import gleam/uri
import pog
import simplifile

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Start a connection pool for `database_url` and return a `Store` using it.
pub fn new(database_url: String) -> Result(Store, String) {
  let name = process.new_name("community_postgres")
  let url = normalise_url(database_url)
  use config <- result.try(
    pog.url_config(name, url)
    |> result.replace_error(
      "DATABASE_URL is not a valid postgres:// connection URL",
    ),
  )
  let config = case neon_endpoint(url) {
    // Neon routes by SNI; pog only sends SNI in verify-full mode, which
    // normalise_url selects. Neon's documented fallback for clients without
    // SNI is the endpoint id as a startup parameter, so pass it too.
    Some(endpoint) ->
      pog.connection_parameter(config, "options", "endpoint=" <> endpoint)
    None -> config
  }
  use started <- result.try(
    config
    |> pog.pool_size(10)
    |> pog.start
    |> result.map_error(fn(error) {
      "could not start postgres pool: " <> string.inspect(error)
    }),
  )
  let db = started.data
  use _ <- result.try(wait_until_connected(db, 20))
  apply_schema(db)
  Ok(store_for(db))
}

/// Make hosted-Postgres connection strings work as pasted. `pog.url_config`
/// insists on an explicit port and only enables TLS when `sslmode` is in the
/// URL; Neon, Supabase and Render omit the port and require TLS. `require` is
/// upgraded to `verify-full` for non-local hosts: pog only sends the TLS
/// server name (SNI) when verifying, and Neon rejects connections without it.
pub fn normalise_url(database_url: String) -> String {
  case uri.parse(database_url) {
    Error(_) -> database_url
    Ok(parsed) -> {
      let port = option.or(parsed.port, Some(5432))
      let local = case parsed.host {
        Some("localhost") | Some("127.0.0.1") | Some("::1") -> True
        _ -> False
      }
      let query = case parsed.query, local {
        Some(q), _ if q != "" ->
          case string.contains(q, "sslmode="), local {
            True, False ->
              Some(string.replace(q, "sslmode=require", "sslmode=verify-full"))
            True, True -> Some(q)
            False, False -> Some(q <> "&sslmode=verify-full")
            False, True -> Some(q)
          }
        _, True -> None
        _, False -> Some("sslmode=verify-full")
      }
      uri.Uri(..parsed, port:, query:) |> uri.to_string
    }
  }
}

/// `ep-cool-name-123456-pooler` for a `*.neon.tech` host, else None.
pub fn neon_endpoint(database_url: String) -> Option(String) {
  case uri.parse(database_url) {
    Ok(uri.Uri(host: Some(host), ..)) if host != "" ->
      case string.ends_with(host, ".neon.tech"), string.split(host, ".") {
        True, [endpoint, ..] -> Some(endpoint)
        _, _ -> None
      }
    _ -> None
  }
}

/// The pool connects asynchronously; give it a moment and surface a readable
/// error instead of letting every request fail with a 500.
fn wait_until_connected(
  db: pog.Connection,
  attempts: Int,
) -> Result(Nil, String) {
  case pog.query("SELECT 1") |> pog.execute(db) {
    Ok(_) -> Ok(Nil)
    Error(error) if attempts <= 1 ->
      Error(
        "could not reach the database: "
        <> string.inspect(error)
        <> " (check DATABASE_URL, and that the host allows TLS connections)",
      )
    Error(_) -> {
      process.sleep(500)
      wait_until_connected(db, attempts - 1)
    }
  }
}

/// Apply `sql/schema.sql` if it sits next to the service. Comments are
/// stripped, statements split on `;`, and the BEGIN/COMMIT wrapper dropped
/// because the extended query protocol runs one statement at a time.
fn apply_schema(db: pog.Connection) -> Nil {
  case simplifile.read("sql/schema.sql") {
    Error(_) ->
      io.println(
        "community: sql/schema.sql not found next to the service, skipping schema check",
      )
    Ok(sql) -> {
      let statements =
        sql
        |> string.split(
          "
",
        )
        |> list.filter(fn(line) { !string.starts_with(string.trim(line), "--") })
        |> string.join(
          "
",
        )
        |> string.split(";")
        |> list.map(string.trim)
        |> list.filter(fn(statement) {
          statement != ""
          && string.uppercase(statement) != "BEGIN"
          && string.uppercase(statement) != "COMMIT"
        })
      let applied =
        list.try_each(statements, fn(statement) {
          pog.query(statement) |> pog.execute(db) |> result.replace(Nil)
        })
      case applied {
        Ok(_) ->
          io.println(
            "community: database schema checked ("
            <> int.to_string(list.length(statements))
            <> " statements)",
          )
        Error(error) ->
          io.println(
            "community: could not apply sql/schema.sql: "
            <> string.inspect(error),
          )
      }
    }
  }
}

fn store_for(db: pog.Connection) -> Store {
  Store(
    kind: "postgres",
    insert_user: insert_user(db, _),
    get_user: get_user(db, _),
    get_user_by_handle: get_user_by_handle(db, _),
    insert_session: insert_session(db, _),
    get_session_user: get_session_user(db, _),
    delete_session: delete_session(db, _),
    insert_item: insert_item(db, _),
    get_item: get_item(db, _),
    update_item: update_item(db, _),
    delete_item: delete_item(db, _),
    list_items: list_items(db, _),
    list_remixes: list_remixes(db, _),
    add_like: fn(user_id, item_id) { add_like(db, user_id, item_id) },
    remove_like: fn(user_id, item_id) { remove_like(db, user_id, item_id) },
    insert_comment: insert_comment(db, _),
    get_comment: get_comment(db, _),
    list_comments: list_comments(db, _),
    delete_comment: delete_comment(db, _),
    get_or_create_short_link: fn(item_id, code) {
      get_or_create_short_link(db, item_id, code)
    },
    get_short_link: get_short_link(db, _),
    insert_score: insert_score(db, _),
    list_scores: fn(song_id, limit) { list_scores(db, song_id, limit) },
  )
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

fn run(
  query: pog.Query(t),
  db: pog.Connection,
) -> Result(pog.Returned(t), StoreError) {
  pog.execute(query, db) |> result.map_error(map_error)
}

fn map_error(error: pog.QueryError) -> StoreError {
  case error {
    pog.ConstraintViolated(_, constraint, _) -> Conflict(constraint)
    other -> Unavailable(string.inspect(other))
  }
}

/// Exactly one row, or NotFound.
fn one(result: Result(pog.Returned(t), StoreError)) -> Result(t, StoreError) {
  case result {
    Ok(pog.Returned(_, [row, ..])) -> Ok(row)
    Ok(_) -> Error(NotFound)
    Error(error) -> Error(error)
  }
}

fn rows(
  result: Result(pog.Returned(t), StoreError),
) -> Result(List(t), StoreError) {
  result.map(result, fn(returned) { returned.rows })
}

/// At least one affected row, or NotFound.
fn affected(
  result: Result(pog.Returned(t), StoreError),
) -> Result(Nil, StoreError) {
  case result {
    Ok(pog.Returned(count, _)) if count > 0 -> Ok(Nil)
    Ok(_) -> Error(NotFound)
    Error(error) -> Error(error)
  }
}

fn in_transaction(
  db: pog.Connection,
  callback: fn(pog.Connection) -> Result(t, StoreError),
) -> Result(t, StoreError) {
  case pog.transaction(db, callback) {
    Ok(value) -> Ok(value)
    Error(pog.TransactionRolledBack(error)) -> Error(error)
    Error(pog.TransactionQueryError(error)) -> Error(map_error(error))
  }
}

fn text_array(values: List(String)) -> pog.Value {
  pog.array(pog.text, values)
}

// ---------------------------------------------------------------------------
// Row decoders
// ---------------------------------------------------------------------------

const user_columns = "id, handle, display_name, password_hash, created_at"

fn user_decoder() -> decode.Decoder(User) {
  use id <- decode.field(0, decode.string)
  use handle <- decode.field(1, decode.string)
  use display_name <- decode.field(2, decode.string)
  use password_hash <- decode.field(3, decode.string)
  use created_at <- decode.field(4, pog.timestamp_decoder())
  decode.success(User(id:, handle:, display_name:, password_hash:, created_at:))
}

const item_columns = "id, kind, title, description, author_id, tags, payload::text, parent_id, like_count, comment_count, created_at, updated_at"

fn item_decoder() -> decode.Decoder(Item) {
  use id <- decode.field(0, decode.string)
  use kind <- decode.field(1, decode.string)
  use title <- decode.field(2, decode.string)
  use description <- decode.field(3, decode.string)
  use author_id <- decode.field(4, decode.string)
  use tags <- decode.field(5, decode.list(decode.string))
  use payload <- decode.field(6, decode.string)
  use parent_id <- decode.field(7, decode.optional(decode.string))
  use like_count <- decode.field(8, decode.int)
  use comment_count <- decode.field(9, decode.int)
  use created_at <- decode.field(10, pog.timestamp_decoder())
  use updated_at <- decode.field(11, pog.timestamp_decoder())
  decode.success(Item(
    id:,
    kind:,
    title:,
    description:,
    author_id:,
    tags:,
    payload:,
    parent_id:,
    like_count:,
    comment_count:,
    created_at:,
    updated_at:,
  ))
}

const comment_columns = "id, item_id, author_id, body, created_at"

fn comment_decoder() -> decode.Decoder(Comment) {
  use id <- decode.field(0, decode.string)
  use item_id <- decode.field(1, decode.string)
  use author_id <- decode.field(2, decode.string)
  use body <- decode.field(3, decode.string)
  use created_at <- decode.field(4, pog.timestamp_decoder())
  decode.success(Comment(id:, item_id:, author_id:, body:, created_at:))
}

const score_columns = "id, user_id, song_id, score, accuracy, run, rating, variations, created_at"

fn score_decoder() -> decode.Decoder(Score) {
  use id <- decode.field(0, decode.string)
  use user_id <- decode.field(1, decode.string)
  use song_id <- decode.field(2, decode.string)
  use score <- decode.field(3, decode.int)
  use accuracy <- decode.field(4, decode.float)
  use run <- decode.field(5, decode.int)
  use rating <- decode.field(6, decode.string)
  use variations <- decode.field(7, decode.list(decode.string))
  use created_at <- decode.field(8, pog.timestamp_decoder())
  decode.success(Score(
    id:,
    user_id:,
    song_id:,
    score:,
    accuracy:,
    run:,
    rating:,
    variations:,
    created_at:,
  ))
}

fn short_link_decoder() -> decode.Decoder(ShortLink) {
  use code <- decode.field(0, decode.string)
  use item_id <- decode.field(1, decode.string)
  decode.success(ShortLink(code:, item_id:))
}

fn int_decoder() -> decode.Decoder(Int) {
  use value <- decode.field(0, decode.int)
  decode.success(value)
}

fn string_decoder() -> decode.Decoder(String) {
  use value <- decode.field(0, decode.string)
  decode.success(value)
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

fn insert_user(db: pog.Connection, user: User) -> Result(User, StoreError) {
  pog.query(
    "INSERT INTO users (id, handle, display_name, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING " <> user_columns,
  )
  |> pog.parameter(pog.text(user.id))
  |> pog.parameter(pog.text(user.handle))
  |> pog.parameter(pog.text(user.display_name))
  |> pog.parameter(pog.text(user.password_hash))
  |> pog.parameter(pog.timestamp(user.created_at))
  |> pog.returning(user_decoder())
  |> run(db)
  |> one
}

fn get_user(db: pog.Connection, id: String) -> Result(User, StoreError) {
  pog.query("SELECT " <> user_columns <> " FROM users WHERE id = $1")
  |> pog.parameter(pog.text(id))
  |> pog.returning(user_decoder())
  |> run(db)
  |> one
}

fn get_user_by_handle(
  db: pog.Connection,
  handle: String,
) -> Result(User, StoreError) {
  pog.query("SELECT " <> user_columns <> " FROM users WHERE handle = $1")
  |> pog.parameter(pog.text(handle))
  |> pog.returning(user_decoder())
  |> run(db)
  |> one
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

fn insert_session(
  db: pog.Connection,
  session: Session,
) -> Result(Nil, StoreError) {
  let Session(token_hash:, user_id:, created_at:) = session
  pog.query(
    "INSERT INTO sessions (token_hash, user_id, created_at) VALUES ($1, $2, $3)",
  )
  |> pog.parameter(pog.text(token_hash))
  |> pog.parameter(pog.text(user_id))
  |> pog.parameter(pog.timestamp(created_at))
  |> run(db)
  |> result.replace(Nil)
}

fn get_session_user(
  db: pog.Connection,
  token_hash: String,
) -> Result(User, StoreError) {
  pog.query(
    "SELECT u.id, u.handle, u.display_name, u.password_hash, u.created_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1",
  )
  |> pog.parameter(pog.text(token_hash))
  |> pog.returning(user_decoder())
  |> run(db)
  |> one
}

fn delete_session(
  db: pog.Connection,
  token_hash: String,
) -> Result(Nil, StoreError) {
  pog.query("DELETE FROM sessions WHERE token_hash = $1")
  |> pog.parameter(pog.text(token_hash))
  |> run(db)
  |> result.replace(Nil)
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

fn insert_item(db: pog.Connection, item: Item) -> Result(Item, StoreError) {
  pog.query("INSERT INTO items
       (id, kind, title, description, author_id, tags, payload, parent_id,
        like_count, comment_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 0, 0, $9, $9)
     RETURNING " <> item_columns)
  |> pog.parameter(pog.text(item.id))
  |> pog.parameter(pog.text(item.kind))
  |> pog.parameter(pog.text(item.title))
  |> pog.parameter(pog.text(item.description))
  |> pog.parameter(pog.text(item.author_id))
  |> pog.parameter(text_array(item.tags))
  |> pog.parameter(pog.text(item.payload))
  |> pog.parameter(pog.nullable(pog.text, item.parent_id))
  |> pog.parameter(pog.timestamp(item.created_at))
  |> pog.returning(item_decoder())
  |> run(db)
  |> one
}

fn get_item(db: pog.Connection, id: String) -> Result(Item, StoreError) {
  pog.query("SELECT " <> item_columns <> " FROM items WHERE id = $1")
  |> pog.parameter(pog.text(id))
  |> pog.returning(item_decoder())
  |> run(db)
  |> one
}

fn update_item(db: pog.Connection, item: Item) -> Result(Item, StoreError) {
  pog.query("UPDATE items
     SET title = $2, description = $3, tags = $4, payload = $5::jsonb,
         updated_at = $6
     WHERE id = $1
     RETURNING " <> item_columns)
  |> pog.parameter(pog.text(item.id))
  |> pog.parameter(pog.text(item.title))
  |> pog.parameter(pog.text(item.description))
  |> pog.parameter(text_array(item.tags))
  |> pog.parameter(pog.text(item.payload))
  |> pog.parameter(pog.timestamp(item.updated_at))
  |> pog.returning(item_decoder())
  |> run(db)
  |> one
}

fn delete_item(db: pog.Connection, id: String) -> Result(Nil, StoreError) {
  // likes/comments/short_links cascade; children get parent_id set to NULL.
  pog.query("DELETE FROM items WHERE id = $1")
  |> pog.parameter(pog.text(id))
  |> run(db)
  |> affected
}

fn list_remixes(
  db: pog.Connection,
  parent_id: String,
) -> Result(List(Item), StoreError) {
  pog.query(
    "SELECT "
    <> item_columns
    <> " FROM items WHERE parent_id = $1 ORDER BY created_at DESC, id DESC",
  )
  |> pog.parameter(pog.text(parent_id))
  |> pog.returning(item_decoder())
  |> run(db)
  |> rows
}

type Where {
  Where(clauses: List(String), params: List(pog.Value), count: Int)
}

fn add_clause(
  where: Where,
  value: Option(String),
  make_sql: fn(String) -> String,
  make_param: fn(String) -> pog.Value,
) -> Where {
  case value {
    None -> where
    Some(value) -> {
      let count = where.count + 1
      let placeholder = "$" <> int.to_string(count)
      Where(
        clauses: [make_sql(placeholder), ..where.clauses],
        params: [make_param(value), ..where.params],
        count:,
      )
    }
  }
}

fn escape_like(value: String) -> String {
  value
  |> string.replace("\\", "\\\\")
  |> string.replace("%", "\\%")
  |> string.replace("_", "\\_")
}

fn apply_params(query: pog.Query(t), params: List(pog.Value)) -> pog.Query(t) {
  list.fold(params, query, pog.parameter)
}

fn list_items(
  db: pog.Connection,
  query: ItemQuery,
) -> Result(Page(Item), StoreError) {
  let where =
    Where(clauses: [], params: [], count: 0)
    |> add_clause(query.kind, fn(p) { "kind = " <> p }, pog.text)
    |> add_clause(query.author, fn(p) { "author_id = " <> p }, pog.text)
    |> add_clause(query.tag, fn(p) { p <> " = ANY(tags)" }, pog.text)
    |> add_clause(
      query.q,
      fn(p) { "(title ILIKE " <> p <> " OR description ILIKE " <> p <> ")" },
      fn(q) { pog.text("%" <> escape_like(q) <> "%") },
    )

  let where_sql = case where.clauses {
    [] -> ""
    clauses -> " WHERE " <> string.join(list.reverse(clauses), " AND ")
  }
  let params = list.reverse(where.params)

  let order_sql = case query.sort {
    store.Newest -> " ORDER BY created_at DESC, id DESC"
    store.Top -> " ORDER BY like_count DESC, created_at DESC, id DESC"
  }

  let limit_placeholder = "$" <> int.to_string(where.count + 1)
  let offset_placeholder = "$" <> int.to_string(where.count + 2)
  let offset = { query.page - 1 } * query.per_page

  use total <- result.try(
    pog.query("SELECT COUNT(*)::int FROM items" <> where_sql)
    |> apply_params(params)
    |> pog.returning(int_decoder())
    |> run(db)
    |> one,
  )

  use items <- result.try(
    pog.query(
      "SELECT "
      <> item_columns
      <> " FROM items"
      <> where_sql
      <> order_sql
      <> " LIMIT "
      <> limit_placeholder
      <> " OFFSET "
      <> offset_placeholder,
    )
    |> apply_params(params)
    |> pog.parameter(pog.int(query.per_page))
    |> pog.parameter(pog.int(offset))
    |> pog.returning(item_decoder())
    |> run(db)
    |> rows,
  )

  Ok(Page(items:, page: query.page, per_page: query.per_page, total:))
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

fn add_like(
  db: pog.Connection,
  user_id: String,
  item_id: String,
) -> Result(Int, StoreError) {
  use tx <- in_transaction(db)
  use inserted <- result.try(
    pog.query(
      "INSERT INTO likes (user_id, item_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING",
    )
    |> pog.parameter(pog.text(user_id))
    |> pog.parameter(pog.text(item_id))
    |> run(tx),
  )
  case inserted.count {
    0 -> current_like_count(tx, item_id)
    _ ->
      pog.query(
        "UPDATE items SET like_count = like_count + 1
         WHERE id = $1 RETURNING like_count",
      )
      |> pog.parameter(pog.text(item_id))
      |> pog.returning(int_decoder())
      |> run(tx)
      |> one
  }
}

fn remove_like(
  db: pog.Connection,
  user_id: String,
  item_id: String,
) -> Result(Int, StoreError) {
  use tx <- in_transaction(db)
  use deleted <- result.try(
    pog.query("DELETE FROM likes WHERE user_id = $1 AND item_id = $2")
    |> pog.parameter(pog.text(user_id))
    |> pog.parameter(pog.text(item_id))
    |> run(tx),
  )
  case deleted.count {
    0 -> current_like_count(tx, item_id)
    _ ->
      pog.query(
        "UPDATE items SET like_count = GREATEST(like_count - 1, 0)
         WHERE id = $1 RETURNING like_count",
      )
      |> pog.parameter(pog.text(item_id))
      |> pog.returning(int_decoder())
      |> run(tx)
      |> one
  }
}

fn current_like_count(
  db: pog.Connection,
  item_id: String,
) -> Result(Int, StoreError) {
  pog.query("SELECT like_count FROM items WHERE id = $1")
  |> pog.parameter(pog.text(item_id))
  |> pog.returning(int_decoder())
  |> run(db)
  |> one
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

fn insert_comment(
  db: pog.Connection,
  comment: Comment,
) -> Result(Comment, StoreError) {
  use tx <- in_transaction(db)
  use _ <- result.try(
    pog.query(
      "UPDATE items SET comment_count = comment_count + 1 WHERE id = $1",
    )
    |> pog.parameter(pog.text(comment.item_id))
    |> run(tx)
    |> affected,
  )
  pog.query("INSERT INTO comments (id, item_id, author_id, body, created_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING " <> comment_columns)
  |> pog.parameter(pog.text(comment.id))
  |> pog.parameter(pog.text(comment.item_id))
  |> pog.parameter(pog.text(comment.author_id))
  |> pog.parameter(pog.text(comment.body))
  |> pog.parameter(pog.timestamp(comment.created_at))
  |> pog.returning(comment_decoder())
  |> run(tx)
  |> one
}

fn get_comment(db: pog.Connection, id: String) -> Result(Comment, StoreError) {
  pog.query("SELECT " <> comment_columns <> " FROM comments WHERE id = $1")
  |> pog.parameter(pog.text(id))
  |> pog.returning(comment_decoder())
  |> run(db)
  |> one
}

fn list_comments(
  db: pog.Connection,
  item_id: String,
) -> Result(List(Comment), StoreError) {
  pog.query(
    "SELECT "
    <> comment_columns
    <> " FROM comments WHERE item_id = $1 ORDER BY created_at ASC, id ASC",
  )
  |> pog.parameter(pog.text(item_id))
  |> pog.returning(comment_decoder())
  |> run(db)
  |> rows
}

fn delete_comment(db: pog.Connection, id: String) -> Result(Nil, StoreError) {
  use tx <- in_transaction(db)
  use item_id <- result.try(
    pog.query("DELETE FROM comments WHERE id = $1 RETURNING item_id")
    |> pog.parameter(pog.text(id))
    |> pog.returning(string_decoder())
    |> run(tx)
    |> one,
  )
  pog.query(
    "UPDATE items SET comment_count = GREATEST(comment_count - 1, 0)
     WHERE id = $1",
  )
  |> pog.parameter(pog.text(item_id))
  |> run(tx)
  |> result.replace(Nil)
}

// ---------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------

fn get_or_create_short_link(
  db: pog.Connection,
  item_id: String,
  code: String,
) -> Result(ShortLink, StoreError) {
  use tx <- in_transaction(db)
  use _ <- result.try(
    pog.query("SELECT 1 FROM items WHERE id = $1")
    |> pog.parameter(pog.text(item_id))
    |> pog.returning(int_decoder())
    |> run(tx)
    |> one,
  )
  let existing =
    pog.query("SELECT code, item_id FROM short_links WHERE item_id = $1")
    |> pog.parameter(pog.text(item_id))
    |> pog.returning(short_link_decoder())
    |> run(tx)
    |> one
  case existing {
    Ok(link) -> Ok(link)
    Error(NotFound) ->
      pog.query(
        "INSERT INTO short_links (code, item_id) VALUES ($1, $2)
         RETURNING code, item_id",
      )
      |> pog.parameter(pog.text(code))
      |> pog.parameter(pog.text(item_id))
      |> pog.returning(short_link_decoder())
      |> run(tx)
      |> one
    Error(error) -> Error(error)
  }
}

fn get_short_link(
  db: pog.Connection,
  code: String,
) -> Result(ShortLink, StoreError) {
  pog.query("SELECT code, item_id FROM short_links WHERE code = $1")
  |> pog.parameter(pog.text(code))
  |> pog.returning(short_link_decoder())
  |> run(db)
  |> one
}

// ---------------------------------------------------------------------------
// Stage boards
// ---------------------------------------------------------------------------

fn insert_score(db: pog.Connection, score: Score) -> Result(Score, StoreError) {
  pog.query(
    "INSERT INTO scores (id, user_id, song_id, score, accuracy, run, rating, variations, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING "
    <> score_columns,
  )
  |> pog.parameter(pog.text(score.id))
  |> pog.parameter(pog.text(score.user_id))
  |> pog.parameter(pog.text(score.song_id))
  |> pog.parameter(pog.int(score.score))
  |> pog.parameter(pog.float(score.accuracy))
  |> pog.parameter(pog.int(score.run))
  |> pog.parameter(pog.text(score.rating))
  |> pog.parameter(text_array(score.variations))
  |> pog.parameter(pog.timestamp(score.created_at))
  |> pog.returning(score_decoder())
  |> run(db)
  |> one
}

/// Best set per user for the song, highest first. DISTINCT ON keeps one row
/// per user (their top score), then the outer ORDER BY ranks those.
fn list_scores(
  db: pog.Connection,
  song_id: String,
  limit: Int,
) -> Result(List(Score), StoreError) {
  pog.query("SELECT " <> score_columns <> " FROM (
       SELECT DISTINCT ON (user_id) " <> score_columns <> "
       FROM scores WHERE song_id = $1
       ORDER BY user_id, score DESC, created_at ASC
     ) best
     ORDER BY score DESC, created_at ASC
     LIMIT $2")
  |> pog.parameter(pog.text(song_id))
  |> pog.parameter(pog.int(limit))
  |> pog.returning(score_decoder())
  |> run(db)
  |> rows
}
