//// Item handlers: listing, CRUD, remixes and remix chains.

import community/auth
import community/ids
import community/json_codec
import community/store.{type Item, type ItemQuery, type User, Item, ItemQuery}
import community/web.{type AppError, type Context, BadRequest, Forbidden}
import gleam/dict
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import gleam/string
import gleam/time/timestamp
import wisp.{type Request, type Response}

pub const kinds = ["song", "tutorial", "preset", "theme", "loop"]

const max_chain_length = 50

const default_per_page = 20

const max_per_page = 100

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

pub fn load_item(ctx: Context, id: String) -> Result(Item, AppError) {
  ctx.store.get_item(id)
  |> result.map_error(web.store_error(_, "item not found"))
}

fn load_user(ctx: Context, id: String) -> Option(User) {
  ctx.store.get_user(id) |> option.from_result
}

/// Authenticate and load the item, requiring the caller to be its author.
pub fn require_author(
  ctx: Context,
  request: Request,
  id: String,
) -> Result(#(User, Item), AppError) {
  use user <- result.try(auth.authenticate(ctx, request))
  use item <- result.try(load_item(ctx, id))
  case item.author_id == user.id {
    True -> Ok(#(user, item))
    False -> Error(Forbidden("only the author can modify this item"))
  }
}

/// Item JSON with author and parent embedded.
fn detail_json(ctx: Context, item: Item) -> json.Json {
  let parent = case item.parent_id {
    Some(parent_id) -> ctx.store.get_item(parent_id) |> option.from_result
    None -> None
  }
  json_codec.item_with(item, load_user(ctx, item.author_id), parent)
}

/// Encode a list of items, embedding authors (each looked up once).
fn list_json(ctx: Context, items: List(Item)) -> List(json.Json) {
  let authors =
    items
    |> list.map(fn(item) { item.author_id })
    |> list.unique
    |> list.filter_map(fn(id) {
      ctx.store.get_user(id) |> result.map(fn(user) { #(id, user) })
    })
    |> dict.from_list
  list.map(items, fn(item) {
    json_codec.item_with(
      item,
      dict.get(authors, item.author_id) |> option.from_result,
      None,
    )
  })
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub fn validate_kind(kind: String) -> Result(String, AppError) {
  let kind = kind |> string.trim |> string.lowercase
  case list.contains(kinds, kind) {
    True -> Ok(kind)
    False ->
      Error(BadRequest("kind must be one of: " <> string.join(kinds, ", ")))
  }
}

fn validate_title(title: String) -> Result(String, AppError) {
  web.check_length(title, "title", 1, 120)
}

fn validate_description(description: String) -> Result(String, AppError) {
  web.check_length(description, "description", 0, 2000)
}

fn validate_tags(tags: List(String)) -> Result(List(String), AppError) {
  use tags <- result.try(
    list.try_map(tags, fn(tag) {
      web.check_length(string.lowercase(tag), "tag", 1, 32)
    }),
  )
  let tags = list.unique(tags)
  case list.length(tags) > 20 {
    True -> Error(BadRequest("at most 20 tags are allowed"))
    False -> Ok(tags)
  }
}

fn validate_payload(payload: String) -> Result(String, AppError) {
  case string.byte_size(payload) > web.max_payload_bytes {
    True -> Error(web.PayloadTooLarge)
    False -> Ok(payload)
  }
}

fn validate_parent(
  ctx: Context,
  parent_id: Option(String),
) -> Result(Option(String), AppError) {
  case parent_id {
    None -> Ok(None)
    Some(id) ->
      case ctx.store.get_item(id) {
        Ok(parent) -> Ok(Some(parent.id))
        Error(store.NotFound) -> Error(BadRequest("parent_id: item not found"))
        Error(other) -> Error(web.store_error(other, "item not found"))
      }
  }
}

fn parse_query(request: Request) -> Result(ItemQuery, AppError) {
  let params = wisp.get_query(request)
  let get = fn(key) {
    case list.key_find(params, key) {
      Ok(value) if value != "" -> Some(string.trim(value))
      _ -> None
    }
  }

  use kind <- result.try(case get("kind") {
    Some(kind) -> validate_kind(kind) |> result.map(Some)
    None -> Ok(None)
  })
  use sort <- result.try(case get("sort") {
    None | Some("new") -> Ok(store.Newest)
    Some("top") -> Ok(store.Top)
    Some(_) -> Error(BadRequest("sort must be 'new' or 'top'"))
  })
  use page <- result.try(parse_positive_int(get("page"), "page", 1))
  use per_page <- result.try(parse_positive_int(
    get("per_page"),
    "per_page",
    default_per_page,
  ))

  Ok(ItemQuery(
    kind:,
    q: get("q") |> option.map(string.lowercase),
    tag: get("tag") |> option.map(string.lowercase),
    author: get("author"),
    sort:,
    page:,
    per_page: int.min(per_page, max_per_page),
  ))
}

fn parse_positive_int(
  value: Option(String),
  name: String,
  default: Int,
) -> Result(Int, AppError) {
  case value {
    None -> Ok(default)
    Some(text) ->
      case int.parse(text) {
        Ok(n) if n >= 1 -> Ok(n)
        _ -> Error(BadRequest(name <> " must be a positive integer"))
      }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /items?kind=&q=&tag=&author=&sort=new|top&page=&per_page=
pub fn list(ctx: Context, request: Request) -> Response {
  web.respond({
    use query <- result.try(parse_query(request))
    use page <- result.try(
      ctx.store.list_items(query)
      |> result.map_error(web.store_error(_, "items not found")),
    )
    let encoded = store.Page(..page, items: list_json(ctx, page.items))
    Ok(web.json(200, json_codec.items_page(encoded)))
  })
}

/// POST /items (auth) { kind, title, description, tags, payload, parent_id? }
pub fn create(ctx: Context, request: Request) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use body <- result.try(web.read_json(
      request,
      json_codec.create_item_decoder(),
    ))
    use kind <- result.try(validate_kind(body.kind))
    use title <- result.try(validate_title(body.title))
    use description <- result.try(validate_description(body.description))
    use tags <- result.try(validate_tags(body.tags))
    use payload <- result.try(validate_payload(body.payload))
    use parent_id <- result.try(validate_parent(ctx, body.parent_id))

    let now = timestamp.system_time()
    let item =
      Item(
        id: ids.new_id(),
        kind:,
        title:,
        description:,
        author_id: user.id,
        tags:,
        payload:,
        parent_id:,
        like_count: 0,
        comment_count: 0,
        created_at: now,
        updated_at: now,
      )
    use item <- result.try(
      ctx.store.insert_item(item)
      |> result.map_error(fn(error) {
        case error {
          store.Conflict(_) -> BadRequest("parent_id: item not found")
          other -> web.store_error(other, "item not found")
        }
      }),
    )
    Ok(web.json(201, detail_json(ctx, item)))
  })
}

/// GET /items/:id
pub fn show(ctx: Context, id: String) -> Response {
  web.respond({
    use item <- result.try(load_item(ctx, id))
    Ok(web.json(200, detail_json(ctx, item)))
  })
}

/// PATCH /items/:id (auth, author only) { title?, description?, tags?, payload? }
pub fn update(ctx: Context, request: Request, id: String) -> Response {
  web.respond({
    use #(_user, item) <- result.try(require_author(ctx, request, id))
    use body <- result.try(web.read_json(
      request,
      json_codec.patch_item_decoder(),
    ))
    use title <- result.try(case body.title {
      Some(title) -> validate_title(title)
      None -> Ok(item.title)
    })
    use description <- result.try(case body.description {
      Some(description) -> validate_description(description)
      None -> Ok(item.description)
    })
    use tags <- result.try(case body.tags {
      Some(tags) -> validate_tags(tags)
      None -> Ok(item.tags)
    })
    use payload <- result.try(case body.payload {
      Some(payload) -> validate_payload(payload)
      None -> Ok(item.payload)
    })

    let updated =
      Item(
        ..item,
        title:,
        description:,
        tags:,
        payload:,
        updated_at: timestamp.system_time(),
      )
    use updated <- result.try(
      ctx.store.update_item(updated)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(web.json(200, detail_json(ctx, updated)))
  })
}

/// DELETE /items/:id (auth, author only) -> 204
pub fn delete(ctx: Context, request: Request, id: String) -> Response {
  web.respond({
    use #(_user, item) <- result.try(require_author(ctx, request, id))
    use _ <- result.try(
      ctx.store.delete_item(item.id)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(wisp.no_content())
  })
}

/// GET /items/:id/remixes -> { items: [...] }
pub fn remixes(ctx: Context, id: String) -> Response {
  web.respond({
    use _item <- result.try(load_item(ctx, id))
    use children <- result.try(
      ctx.store.list_remixes(id)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(web.json(
      200,
      json.object([
        #("items", json.preprocessed_array(list_json(ctx, children))),
      ]),
    ))
  })
}

/// GET /items/:id/chain -> { chain: [root, ..., item] } (max 50 entries)
pub fn chain(ctx: Context, id: String) -> Response {
  web.respond({
    use item <- result.try(load_item(ctx, id))
    let chain = walk_chain(ctx, item, [item], [item.id])
    Ok(web.json(
      200,
      json.object([
        #("chain", json.preprocessed_array(list_json(ctx, chain))),
      ]),
    ))
  })
}

/// Walk `parent_id` upward, accumulating root-first. Stops at a missing
/// parent, a cycle, or `max_chain_length` entries.
fn walk_chain(
  ctx: Context,
  current: Item,
  acc: List(Item),
  seen: List(String),
) -> List(Item) {
  case current.parent_id {
    None -> acc
    Some(parent_id) ->
      case
        list.length(acc) >= max_chain_length || list.contains(seen, parent_id)
      {
        True -> acc
        False ->
          case ctx.store.get_item(parent_id) {
            Ok(parent) ->
              walk_chain(ctx, parent, [parent, ..acc], [parent_id, ..seen])
            Error(_) -> acc
          }
      }
  }
}
