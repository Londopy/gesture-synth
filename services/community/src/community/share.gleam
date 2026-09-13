//// Share links: POST /items/:id/share creates (or returns) a 6-character code;
//// GET /s/:code redirects to the frontend item page.

import community/ids
import community/items
import community/store.{type ShortLink}
import community/web.{type AppError, type Context, Internal}
import gleam/http
import gleam/http/request
import gleam/http/response
import gleam/int
import gleam/json
import gleam/option.{None, Some}
import gleam/result
import wisp.{type Request, type Response}

const max_code_attempts = 5

/// POST /items/:id/share -> { code, url }
pub fn create(ctx: Context, request: Request, item_id: String) -> Response {
  web.respond({
    use _item <- result.try(items.load_item(ctx, item_id))
    use link <- result.try(create_link(ctx, item_id, max_code_attempts))
    Ok(web.json(
      200,
      json.object([
        #("code", json.string(link.code)),
        #("url", json.string(public_base(request) <> "/s/" <> link.code)),
      ]),
    ))
  })
}

/// Try fresh random codes until one is free (collisions are ~1 in 2^36).
fn create_link(
  ctx: Context,
  item_id: String,
  attempts: Int,
) -> Result(ShortLink, AppError) {
  case ctx.store.get_or_create_short_link(item_id, ids.new_short_code()) {
    Ok(link) -> Ok(link)
    Error(store.Conflict(_)) if attempts > 1 ->
      create_link(ctx, item_id, attempts - 1)
    Error(store.Conflict(_)) ->
      Error(Internal("could not allocate a unique share code"))
    Error(other) -> Error(web.store_error(other, "item not found"))
  }
}

/// GET /s/:code -> 302 to FRONTEND_ORIGIN/<kind>/<item_id>
pub fn redirect(ctx: Context, code: String) -> Response {
  web.respond({
    use link <- result.try(
      ctx.store.get_short_link(code)
      |> result.map_error(web.store_error(_, "share link not found")),
    )
    use item <- result.try(items.load_item(ctx, link.item_id))
    let target =
      ctx.config.frontend_origin <> "/" <> item.kind <> "/" <> item.id
    Ok(
      wisp.response(302)
      |> response.set_header("location", target)
      |> response.set_header("cache-control", "no-store")
      |> wisp.string_body("Redirecting to " <> target),
    )
  })
}

/// Public origin of this service as seen by the client, honouring reverse
/// proxy headers when present.
fn public_base(request: Request) -> String {
  let scheme = case request.get_header(request, "x-forwarded-proto") {
    Ok(proto) -> proto
    Error(_) -> http.scheme_to_string(request.scheme)
  }
  let host = case request.get_header(request, "x-forwarded-host") {
    Ok(host) -> host
    Error(_) ->
      case request.get_header(request, "host") {
        Ok(host) -> host
        Error(_) ->
          case request.port {
            Some(port) -> request.host <> ":" <> int.to_string(port)
            None -> request.host
          }
      }
  }
  scheme <> "://" <> host
}
