//// Comment handlers.

import community/auth
import community/ids
import community/items
import community/json_codec
import community/store.{Comment}
import community/web.{type Context, Forbidden}
import gleam/dict
import gleam/json
import gleam/list
import gleam/option
import gleam/result
import gleam/time/timestamp
import wisp.{type Request, type Response}

/// GET /items/:id/comments -> { comments: [...] } (oldest first)
pub fn list(ctx: Context, item_id: String) -> Response {
  web.respond({
    use _item <- result.try(items.load_item(ctx, item_id))
    use comments <- result.try(
      ctx.store.list_comments(item_id)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    let authors =
      comments
      |> list.map(fn(comment) { comment.author_id })
      |> list.unique
      |> list.filter_map(fn(id) {
        ctx.store.get_user(id) |> result.map(fn(user) { #(id, user) })
      })
      |> dict.from_list
    let encoded =
      list.map(comments, fn(comment) {
        json_codec.comment(
          comment,
          dict.get(authors, comment.author_id) |> option.from_result,
        )
      })
    Ok(web.json(
      200,
      json.object([#("comments", json.preprocessed_array(encoded))]),
    ))
  })
}

/// POST /items/:id/comments (auth) { body } -> 201 comment
pub fn create(ctx: Context, request: Request, item_id: String) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use _item <- result.try(items.load_item(ctx, item_id))
    use body <- result.try(web.read_json(request, json_codec.comment_decoder()))
    use text <- result.try(web.check_length(body.body, "body", 1, 2000))

    let comment =
      Comment(
        id: ids.new_id(),
        item_id:,
        author_id: user.id,
        body: text,
        created_at: timestamp.system_time(),
      )
    use comment <- result.try(
      ctx.store.insert_comment(comment)
      |> result.map_error(web.store_error(_, "item not found")),
    )
    Ok(web.json(201, json_codec.comment(comment, option.Some(user))))
  })
}

/// DELETE /comments/:id (auth, author only) -> 204
pub fn delete(ctx: Context, request: Request, comment_id: String) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use comment <- result.try(
      ctx.store.get_comment(comment_id)
      |> result.map_error(web.store_error(_, "comment not found")),
    )
    use _ <- result.try(case comment.author_id == user.id {
      True -> Ok(Nil)
      False -> Error(Forbidden("only the author can delete this comment"))
    })
    use _ <- result.try(
      ctx.store.delete_comment(comment_id)
      |> result.map_error(web.store_error(_, "comment not found")),
    )
    Ok(wisp.no_content())
  })
}
