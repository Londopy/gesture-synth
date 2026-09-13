//// HTTP routing and cross-cutting middleware (CORS, crash rescue, logging).

import community/auth
import community/comments
import community/config.{type Config}
import community/items
import community/likes
import community/share
import community/web.{type Context}
import gleam/http.{Delete, Get, Options, Patch, Post}
import gleam/http/response
import gleam/json
import gleam/list
import gleam/string
import wisp.{type Request, type Response}

/// Entry point used by both the mist server and the tests.
pub fn handle_request(request: Request, ctx: Context) -> Response {
  let request = wisp.set_max_body_size(request, web.max_body_bytes)
  use <- cors(request, ctx.config)
  use <- wisp.rescue_crashes
  use <- wisp.log_request(request)
  route(request, ctx)
}

fn route(request: Request, ctx: Context) -> Response {
  let segments = wisp.path_segments(request)
  case segments, request.method {
    [], Get -> root()
    ["health"], Get -> health(ctx)

    ["auth", "register"], Post -> auth.register(ctx, request)
    ["auth", "login"], Post -> auth.login(ctx, request)
    ["auth", "logout"], Post -> auth.logout(ctx, request)
    ["me"], Get -> auth.me(ctx, request)

    ["items"], Get -> items.list(ctx, request)
    ["items"], Post -> items.create(ctx, request)
    ["items", id], Get -> items.show(ctx, id)
    ["items", id], Patch -> items.update(ctx, request, id)
    ["items", id], Delete -> items.delete(ctx, request, id)
    ["items", id, "remixes"], Get -> items.remixes(ctx, id)
    ["items", id, "chain"], Get -> items.chain(ctx, id)
    ["items", id, "like"], Post -> likes.like(ctx, request, id)
    ["items", id, "like"], Delete -> likes.unlike(ctx, request, id)
    ["items", id, "comments"], Get -> comments.list(ctx, id)
    ["items", id, "comments"], Post -> comments.create(ctx, request, id)
    ["items", id, "share"], Post -> share.create(ctx, request, id)
    ["comments", id], Delete -> comments.delete(ctx, request, id)
    ["s", code], Get -> share.redirect(ctx, code)

    // Known paths with the wrong method -> 405 with Allow header.
    [], _ | ["health"], _ | ["me"], _ | ["items", _], _ | ["s", _], _ ->
      method_not_allowed(allowed_for(segments))
    ["auth", _], _ | ["items"], _ | ["items", _, _], _ | ["comments", _], _ ->
      method_not_allowed(allowed_for(segments))

    _, _ -> web.error_response(web.NotFound("route not found"))
  }
}

fn allowed_for(segments: List(String)) -> List(http.Method) {
  case segments {
    [] | ["health"] | ["me"] | ["s", _] -> [Get]
    ["auth", _] -> [Post]
    ["items"] -> [Get, Post]
    ["items", _] -> [Get, Patch, Delete]
    ["items", _, "like"] -> [Post, Delete]
    ["items", _, "comments"] -> [Get, Post]
    ["items", _, "share"] -> [Post]
    ["items", _, _] -> [Get]
    ["comments", _] -> [Delete]
    _ -> []
  }
}

fn method_not_allowed(allowed: List(http.Method)) -> Response {
  let allow =
    allowed
    |> list.map(http.method_to_string)
    |> list.append(["OPTIONS"])
    |> string.join(", ")
  web.json(405, web.error_json("method not allowed"))
  |> response.set_header("allow", allow)
}

fn root() -> Response {
  web.json(
    200,
    json.object([
      #("service", json.string("gesture-synth-community")),
      #("health", json.string("/health")),
    ]),
  )
}

fn health(ctx: Context) -> Response {
  web.json(
    200,
    json.object([
      #("ok", json.bool(True)),
      #("store", json.string(ctx.store.kind)),
    ]),
  )
}

// ---------------------------------------------------------------------------
// CORS / cross-origin isolation headers
// ---------------------------------------------------------------------------

/// Answer OPTIONS preflights directly and add CORS + CORP headers to every
/// other response. The frontend is served with COEP: require-corp, so
/// `Cross-Origin-Resource-Policy: cross-origin` is required for fetches.
fn cors(request: Request, config: Config, next: fn() -> Response) -> Response {
  case request.method {
    Options ->
      wisp.response(204)
      |> response.set_header("access-control-max-age", "86400")
      |> add_cors_headers(config)
    _ -> next() |> add_cors_headers(config)
  }
}

fn add_cors_headers(response: Response, config: Config) -> Response {
  let response =
    response
    |> response.set_header("access-control-allow-origin", config.cors_origin)
    |> response.set_header(
      "access-control-allow-methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    )
    |> response.set_header(
      "access-control-allow-headers",
      "Authorization, Content-Type",
    )
    |> response.set_header("access-control-expose-headers", "Location, Allow")
    |> response.set_header("cross-origin-resource-policy", "cross-origin")
  case config.cors_origin {
    "*" -> response
    _ -> response.set_header(response, "vary", "Origin")
  }
}
