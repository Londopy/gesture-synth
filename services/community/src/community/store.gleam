//// Storage interface and domain types.
////
//// `Store` is a record of functions so that the HTTP layer is independent of
//// the backing database. Two implementations exist:
////
//// - `community/store/memory`   — actor-backed, used by tests and dev mode
//// - `community/store/postgres` — pog-based, used when `DATABASE_URL` is set

import gleam/option.{type Option}
import gleam/time/timestamp.{type Timestamp}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

pub type User {
  User(
    id: String,
    handle: String,
    display_name: String,
    password_hash: String,
    created_at: Timestamp,
  )
}

pub type Session {
  Session(token_hash: String, user_id: String, created_at: Timestamp)
}

pub type Item {
  Item(
    id: String,
    kind: String,
    title: String,
    description: String,
    author_id: String,
    tags: List(String),
    /// Opaque JSON document, stored as text (jsonb in Postgres).
    payload: String,
    parent_id: Option(String),
    like_count: Int,
    comment_count: Int,
    created_at: Timestamp,
    updated_at: Timestamp,
  )
}

pub type Comment {
  Comment(
    id: String,
    item_id: String,
    author_id: String,
    body: String,
    created_at: Timestamp,
  )
}

pub type ShortLink {
  ShortLink(code: String, item_id: String)
}

/// One finished Stage set posted to the community board. `song_id` is a
/// built-in song id or a community item id; the service does not check which.
pub type Score {
  Score(
    id: String,
    user_id: String,
    song_id: String,
    score: Int,
    accuracy: Float,
    run: Int,
    rating: String,
    variations: List(String),
    created_at: Timestamp,
  )
}

pub type Sort {
  Newest
  Top
}

pub type ItemQuery {
  ItemQuery(
    kind: Option(String),
    /// Case-insensitive substring match on title or description.
    q: Option(String),
    /// Exact tag match.
    tag: Option(String),
    /// Author user ID.
    author: Option(String),
    sort: Sort,
    /// 1-based page number.
    page: Int,
    per_page: Int,
  )
}

pub type Page(a) {
  Page(items: List(a), page: Int, per_page: Int, total: Int)
}

pub type StoreError {
  NotFound
  /// A uniqueness or foreign-key constraint was violated. The string names
  /// the constraint (e.g. "handle", "short_link_code").
  Conflict(String)
  /// The backend failed or is unreachable.
  Unavailable(String)
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

pub type Store {
  Store(
    /// "memory" or "postgres" — reported by /health.
    kind: String,
    // Users
    insert_user: fn(User) -> Result(User, StoreError),
    get_user: fn(String) -> Result(User, StoreError),
    get_user_by_handle: fn(String) -> Result(User, StoreError),
    // Sessions (keyed by SHA-256 of the bearer token)
    insert_session: fn(Session) -> Result(Nil, StoreError),
    get_session_user: fn(String) -> Result(User, StoreError),
    delete_session: fn(String) -> Result(Nil, StoreError),
    // Items
    insert_item: fn(Item) -> Result(Item, StoreError),
    get_item: fn(String) -> Result(Item, StoreError),
    update_item: fn(Item) -> Result(Item, StoreError),
    delete_item: fn(String) -> Result(Nil, StoreError),
    list_items: fn(ItemQuery) -> Result(Page(Item), StoreError),
    list_remixes: fn(String) -> Result(List(Item), StoreError),
    // Likes: (user_id, item_id) -> resulting like_count. Idempotent.
    add_like: fn(String, String) -> Result(Int, StoreError),
    remove_like: fn(String, String) -> Result(Int, StoreError),
    // Comments
    insert_comment: fn(Comment) -> Result(Comment, StoreError),
    get_comment: fn(String) -> Result(Comment, StoreError),
    list_comments: fn(String) -> Result(List(Comment), StoreError),
    delete_comment: fn(String) -> Result(Nil, StoreError),
    // Short links: (item_id, candidate_code). Returns the existing link for
    // the item if there is one, otherwise creates one with the candidate code.
    // Fails with Conflict if the candidate code is already taken.
    get_or_create_short_link: fn(String, String) ->
      Result(ShortLink, StoreError),
    get_short_link: fn(String) -> Result(ShortLink, StoreError),
    // Stage boards: insert one set; list the best set per user for a song,
    // highest score first, at most `limit` rows.
    insert_score: fn(Score) -> Result(Score, StoreError),
    list_scores: fn(String, Int) -> Result(List(Score), StoreError),
  )
}

pub fn describe_error(error: StoreError) -> String {
  case error {
    NotFound -> "not found"
    Conflict(constraint) -> "conflict: " <> constraint
    Unavailable(reason) -> "store unavailable: " <> reason
  }
}
