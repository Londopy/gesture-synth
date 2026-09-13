//// Like / unlike handlers. Both are idempotent.

import community/auth
import community/items
import community/web.{type Context}
import gleam/json
import gleam/result
import wisp.{type Request, type Response}

/// POST /items/:id/like (auth) -> { liked: true, like_count }
pub fn like(ctx: Context, request: Request, item_id: String) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use _item <- result.try(items.load_item(ctx, item_id))
    use like_count <- result.try(
      ctx.store.add_like(user.id, item_id)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(web.json(200, like_json(True, like_count)))
  })
}

/// DELETE /items/:id/like (auth) -> { liked: false, like_count }
pub fn unlike(ctx: Context, request: Request, item_id: String) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use _item <- result.try(items.load_item(ctx, item_id))
    use like_count <- result.try(
      ctx.store.remove_like(user.id, item_id)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(web.json(200, like_json(False, like_count)))
  })
}

fn like_json(liked: Bool, like_count: Int) -> json.Json {
  json.object([
    #("liked", json.bool(liked)),
    #("like_count", json.int(like_count)),
  ])
}
