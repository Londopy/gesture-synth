//// JSON encoding of domain types and decoding of request bodies.

import community/store.{type Comment, type Item, type Page, type User}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode.{type Decoder}
import gleam/json.{type Json}
import gleam/option.{type Option, None, Some}
import gleam/time/duration
import gleam/time/timestamp.{type Timestamp}

// ---------------------------------------------------------------------------
// FFI: opaque payload handling
// ---------------------------------------------------------------------------

/// Embed JSON text that is already known to be valid as a `Json` value
/// without re-parsing it. Item payloads are stored as text and returned
/// verbatim.
@external(erlang, "community_ffi", "raw_json")
pub fn raw_json(text: String) -> Json

/// Serialise a decoded JSON value back to compact JSON text.
@external(erlang, "community_ffi", "encode_dynamic")
pub fn encode_dynamic(value: Dynamic) -> String

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

pub fn timestamp(value: Timestamp) -> Json {
  json.string(timestamp.to_rfc3339(value, duration.seconds(0)))
}

/// Public user representation (never includes the password hash).
pub fn user(user: User) -> Json {
  json.object([
    #("id", json.string(user.id)),
    #("handle", json.string(user.handle)),
    #("display_name", json.string(user.display_name)),
    #("created_at", timestamp(user.created_at)),
  ])
}

/// Compact author embed.
pub fn author(user: User) -> Json {
  json.object([
    #("id", json.string(user.id)),
    #("handle", json.string(user.handle)),
    #("display_name", json.string(user.display_name)),
  ])
}

fn item_fields(item: Item) -> List(#(String, Json)) {
  [
    #("id", json.string(item.id)),
    #("kind", json.string(item.kind)),
    #("title", json.string(item.title)),
    #("description", json.string(item.description)),
    #("author_id", json.string(item.author_id)),
    #("tags", json.array(item.tags, json.string)),
    #("payload", raw_json(item.payload)),
    #("parent_id", json.nullable(item.parent_id, json.string)),
    #("like_count", json.int(item.like_count)),
    #("comment_count", json.int(item.comment_count)),
    #("created_at", timestamp(item.created_at)),
    #("updated_at", timestamp(item.updated_at)),
  ]
}

pub fn item(item: Item) -> Json {
  json.object(item_fields(item))
}

/// Item with optional embedded `author` and `parent` ({ id, title }).
pub fn item_with(
  item: Item,
  author author_user: Option(User),
  parent parent_item: Option(Item),
) -> Json {
  let fields = item_fields(item)
  let fields = case author_user {
    Some(user) -> [#("author", author(user)), ..fields]
    None -> fields
  }
  let fields = case parent_item {
    Some(parent) -> [
      #(
        "parent",
        json.object([
          #("id", json.string(parent.id)),
          #("title", json.string(parent.title)),
        ]),
      ),
      ..fields
    ]
    None -> [#("parent", json.null()), ..fields]
  }
  json.object(fields)
}

pub fn items_page(page: Page(Json)) -> Json {
  json.object([
    #("items", json.preprocessed_array(page.items)),
    #("page", json.int(page.page)),
    #("per_page", json.int(page.per_page)),
    #("total", json.int(page.total)),
  ])
}

pub fn comment(comment: Comment, author author_user: Option(User)) -> Json {
  let fields = [
    #("id", json.string(comment.id)),
    #("item_id", json.string(comment.item_id)),
    #("author_id", json.string(comment.author_id)),
    #("body", json.string(comment.body)),
    #("created_at", timestamp(comment.created_at)),
  ]
  case author_user {
    Some(user) -> json.object([#("author", author(user)), ..fields])
    None -> json.object(fields)
  }
}

// ---------------------------------------------------------------------------
// Request body decoders
// ---------------------------------------------------------------------------

pub type RegisterBody {
  RegisterBody(handle: String, display_name: String, password: String)
}

pub fn register_decoder() -> Decoder(RegisterBody) {
  use handle <- decode.field("handle", decode.string)
  use display_name <- decode.field("display_name", decode.string)
  use password <- decode.field("password", decode.string)
  decode.success(RegisterBody(handle:, display_name:, password:))
}

pub type LoginBody {
  LoginBody(handle: String, password: String)
}

pub fn login_decoder() -> Decoder(LoginBody) {
  use handle <- decode.field("handle", decode.string)
  use password <- decode.field("password", decode.string)
  decode.success(LoginBody(handle:, password:))
}

pub type CreateItemBody {
  CreateItemBody(
    kind: String,
    title: String,
    description: String,
    tags: List(String),
    /// Compact JSON text of the opaque payload.
    payload: String,
    parent_id: Option(String),
  )
}

pub fn create_item_decoder() -> Decoder(CreateItemBody) {
  use kind <- decode.field("kind", decode.string)
  use title <- decode.field("title", decode.string)
  use description <- decode.optional_field("description", "", decode.string)
  use tags <- decode.optional_field("tags", [], decode.list(decode.string))
  use payload <- decode.field("payload", decode.dynamic)
  use parent_id <- decode.optional_field(
    "parent_id",
    None,
    decode.optional(decode.string),
  )
  decode.success(CreateItemBody(
    kind:,
    title:,
    description:,
    tags:,
    payload: encode_dynamic(payload),
    parent_id:,
  ))
}

pub type PatchItemBody {
  PatchItemBody(
    title: Option(String),
    description: Option(String),
    tags: Option(List(String)),
    payload: Option(String),
  )
}

pub fn patch_item_decoder() -> Decoder(PatchItemBody) {
  use title <- decode.optional_field(
    "title",
    None,
    decode.optional(decode.string),
  )
  use description <- decode.optional_field(
    "description",
    None,
    decode.optional(decode.string),
  )
  use tags <- decode.optional_field(
    "tags",
    None,
    decode.optional(decode.list(decode.string)),
  )
  use payload <- decode.optional_field(
    "payload",
    None,
    decode.map(decode.dynamic, fn(value) { Some(encode_dynamic(value)) }),
  )
  decode.success(PatchItemBody(title:, description:, tags:, payload:))
}

pub type CommentBody {
  CommentBody(body: String)
}

pub fn comment_decoder() -> Decoder(CommentBody) {
  use body <- decode.field("body", decode.string)
  decode.success(CommentBody(body:))
}
