//// End-to-end tests: the full router against the in-memory store, driven
//// through wisp's request simulation helpers.

import community/auth
import community/config
import community/router
import community/store/memory
import community/web.{type Context, Context}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/http
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string
import gleeunit
import wisp.{type Request, type Response}
import wisp/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn new_ctx() -> Context {
  let assert Ok(store) = memory.new()
  Context(store:, config: config.default())
}

fn send(ctx: Context, request: Request) -> Response {
  router.handle_request(request, ctx)
}

fn with_token(request: Request, token: Option(String)) -> Request {
  case token {
    Some(token) -> simulate.header(request, "authorization", "Bearer " <> token)
    None -> request
  }
}

fn get(ctx: Context, path: String) -> Response {
  send(ctx, simulate.request(http.Get, path))
}

fn get_auth(ctx: Context, path: String, token: String) -> Response {
  send(ctx, simulate.request(http.Get, path) |> with_token(Some(token)))
}

fn send_json(
  ctx: Context,
  method: http.Method,
  path: String,
  body: Json,
  token: Option(String),
) -> Response {
  simulate.request(method, path)
  |> simulate.json_body(body)
  |> with_token(token)
  |> send(ctx, _)
}

fn post(ctx: Context, path: String, body: Json, token: Option(String)) {
  send_json(ctx, http.Post, path, body, token)
}

fn delete(ctx: Context, path: String, token: Option(String)) -> Response {
  send(ctx, simulate.request(http.Delete, path) |> with_token(token))
}

fn body(response: Response) -> Dynamic {
  let text = simulate.read_body(response)
  let assert Ok(value) = json.parse(text, decode.dynamic)
    as { "response body was not JSON: " <> text }
  value
}

fn str(value: Dynamic, path: List(String)) -> String {
  let assert Ok(out) = decode.run(value, decode.at(path, decode.string))
    as { "missing string at " <> string.join(path, ".") }
  out
}

fn int_at(value: Dynamic, path: List(String)) -> Int {
  let assert Ok(out) = decode.run(value, decode.at(path, decode.int))
    as { "missing int at " <> string.join(path, ".") }
  out
}

fn bool_at(value: Dynamic, path: List(String)) -> Bool {
  let assert Ok(out) = decode.run(value, decode.at(path, decode.bool))
  out
}

fn list_at(value: Dynamic, path: List(String)) -> List(Dynamic) {
  let assert Ok(out) =
    decode.run(value, decode.at(path, decode.list(decode.dynamic)))
    as { "missing list at " <> string.join(path, ".") }
  out
}

fn error_message(response: Response) -> String {
  str(body(response), ["error"])
}

fn header(response: Response, name: String) -> Result(String, Nil) {
  list.key_find(response.headers, name)
}

/// Register a user; returns #(token, user_id).
fn register(ctx: Context, handle: String) -> #(String, String) {
  let response =
    post(
      ctx,
      "/auth/register",
      json.object([
        #("handle", json.string(handle)),
        #("display_name", json.string("User " <> handle)),
        #("password", json.string("correct horse battery")),
      ]),
      None,
    )
  assert response.status == 201
  let data = body(response)
  #(str(data, ["token"]), str(data, ["user", "id"]))
}

fn item_body(
  kind: String,
  title: String,
  tags: List(String),
  parent: Option(String),
) -> Json {
  json.object([
    #("kind", json.string(kind)),
    #("title", json.string(title)),
    #("description", json.string("Description of " <> title)),
    #("tags", json.array(tags, json.string)),
    #(
      "payload",
      json.object([
        #("bpm", json.int(120)),
        #("notes", json.array([60, 64, 67], json.int)),
        #("nested", json.object([#("ok", json.bool(True))])),
      ]),
    ),
    #("parent_id", json.nullable(parent, json.string)),
  ])
}

/// Create an item; returns its id.
fn create_item(
  ctx: Context,
  token: String,
  kind: String,
  title: String,
  tags: List(String),
  parent: Option(String),
) -> String {
  let response =
    post(ctx, "/items", item_body(kind, title, tags, parent), Some(token))
  assert response.status == 201
  str(body(response), ["id"])
}

// ---------------------------------------------------------------------------
// Health, CORS, routing
// ---------------------------------------------------------------------------

pub fn health_test() {
  let ctx = new_ctx()
  let response = get(ctx, "/health")
  assert response.status == 200
  let data = body(response)
  assert bool_at(data, ["ok"]) == True
  assert str(data, ["store"]) == "memory"
}

pub fn cors_headers_on_every_response_test() {
  let ctx = new_ctx()
  let response = get(ctx, "/health")
  assert header(response, "access-control-allow-origin") == Ok("*")
  assert header(response, "cross-origin-resource-policy") == Ok("cross-origin")

  // Errors carry them too.
  let missing = get(ctx, "/nope")
  assert missing.status == 404
  assert header(missing, "cross-origin-resource-policy") == Ok("cross-origin")
  assert error_message(missing) == "route not found"
}

pub fn cors_preflight_test() {
  let ctx = new_ctx()
  let response =
    send(
      ctx,
      simulate.request(http.Options, "/items")
        |> simulate.header("origin", "http://localhost:5173")
        |> simulate.header("access-control-request-method", "POST"),
    )
  assert response.status == 204
  assert header(response, "access-control-allow-origin") == Ok("*")
  let assert Ok(methods) = header(response, "access-control-allow-methods")
  assert string.contains(methods, "PATCH")
  let assert Ok(headers) = header(response, "access-control-allow-headers")
  assert string.contains(headers, "Authorization")
}

pub fn configured_cors_origin_test() {
  let assert Ok(store) = memory.new()
  let ctx =
    Context(
      store:,
      config: config.Config(
        ..config.default(),
        cors_origin: "https://app.example.com",
      ),
    )
  let response = get(ctx, "/health")
  assert header(response, "access-control-allow-origin")
    == Ok("https://app.example.com")
  assert header(response, "vary") == Ok("Origin")
}

pub fn method_not_allowed_test() {
  let ctx = new_ctx()
  let response = send(ctx, simulate.request(http.Put, "/items"))
  assert response.status == 405
  let assert Ok(allow) = header(response, "allow")
  assert string.contains(allow, "GET")
  assert string.contains(allow, "POST")
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

pub fn password_hashing_test() {
  let hash = auth.hash_password("hunter22hunter22")
  assert string.starts_with(hash, "pbkdf2-sha256$")
  assert auth.verify_password("hunter22hunter22", hash)
  assert !auth.verify_password("hunter22hunter23", hash)
  assert !auth.verify_password("hunter22hunter22", "garbage")
  // Salted: two hashes of the same password differ.
  assert auth.hash_password("hunter22hunter22") != hash
}

pub fn register_and_me_test() {
  let ctx = new_ctx()
  let response =
    post(
      ctx,
      "/auth/register",
      json.object([
        #("handle", json.string("Alice_01")),
        #("display_name", json.string("  Alice  ")),
        #("password", json.string("a long password")),
      ]),
      None,
    )
  assert response.status == 201
  let data = body(response)
  let token = str(data, ["token"])
  assert string.length(token) > 30
  // Handle is normalised, display name trimmed, no password hash leaked.
  assert str(data, ["user", "handle"]) == "alice_01"
  assert str(data, ["user", "display_name"]) == "Alice"
  assert string.length(str(data, ["user", "id"])) == 10
  assert !string.contains(simulate.read_body(response), "password_hash")

  let me = get_auth(ctx, "/me", token)
  assert me.status == 200
  assert str(body(me), ["handle"]) == "alice_01"
}

pub fn register_validation_test() {
  let ctx = new_ctx()
  let bad_handle =
    post(
      ctx,
      "/auth/register",
      json.object([
        #("handle", json.string("no spaces!")),
        #("display_name", json.string("X")),
        #("password", json.string("a long password")),
      ]),
      None,
    )
  assert bad_handle.status == 400
  assert string.contains(error_message(bad_handle), "handle")

  let short_password =
    post(
      ctx,
      "/auth/register",
      json.object([
        #("handle", json.string("bob")),
        #("display_name", json.string("Bob")),
        #("password", json.string("short")),
      ]),
      None,
    )
  assert short_password.status == 400
  assert string.contains(error_message(short_password), "password")

  let missing_field =
    post(
      ctx,
      "/auth/register",
      json.object([#("handle", json.string("bob"))]),
      None,
    )
  assert missing_field.status == 400
  assert string.contains(error_message(missing_field), "display_name")

  let not_json =
    simulate.request(http.Post, "/auth/register")
    |> simulate.string_body("{not json")
    |> send(ctx, _)
  assert not_json.status == 400
}

pub fn duplicate_handle_test() {
  let ctx = new_ctx()
  let _ = register(ctx, "carol")
  let response =
    post(
      ctx,
      "/auth/register",
      json.object([
        #("handle", json.string("CAROL")),
        #("display_name", json.string("Carol 2")),
        #("password", json.string("another password")),
      ]),
      None,
    )
  assert response.status == 409
  assert error_message(response) == "handle is already taken"
}

pub fn login_test() {
  let ctx = new_ctx()
  let _ = register(ctx, "dave")

  let ok =
    post(
      ctx,
      "/auth/login",
      json.object([
        #("handle", json.string("dave")),
        #("password", json.string("correct horse battery")),
      ]),
      None,
    )
  assert ok.status == 200
  let token = str(body(ok), ["token"])
  assert get_auth(ctx, "/me", token).status == 200

  let wrong =
    post(
      ctx,
      "/auth/login",
      json.object([
        #("handle", json.string("dave")),
        #("password", json.string("wrong password!")),
      ]),
      None,
    )
  assert wrong.status == 401

  let unknown =
    post(
      ctx,
      "/auth/login",
      json.object([
        #("handle", json.string("nobody")),
        #("password", json.string("correct horse battery")),
      ]),
      None,
    )
  assert unknown.status == 401
  // Same message for both so handles cannot be enumerated.
  assert error_message(unknown) == error_message(wrong)
}

pub fn logout_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "erin")
  let response =
    send(
      ctx,
      simulate.request(http.Post, "/auth/logout") |> with_token(Some(token)),
    )
  assert response.status == 204
  assert get_auth(ctx, "/me", token).status == 401
}

pub fn auth_required_test() {
  let ctx = new_ctx()
  assert get(ctx, "/me").status == 401
  assert error_message(get(ctx, "/me")) == "missing bearer token"

  let bad =
    send(
      ctx,
      simulate.request(http.Get, "/me")
        |> simulate.header("authorization", "Bearer not-a-real-token"),
    )
  assert bad.status == 401

  let wrong_scheme =
    send(
      ctx,
      simulate.request(http.Get, "/me")
        |> simulate.header("authorization", "Basic abc"),
    )
  assert wrong_scheme.status == 401

  assert post(ctx, "/items", item_body("song", "x", [], None), None).status
    == 401
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

pub fn create_and_get_item_test() {
  let ctx = new_ctx()
  let #(token, user_id) = register(ctx, "frank")

  let created =
    post(
      ctx,
      "/items",
      item_body("song", "  My Song  ", ["Chill", "lofi", "chill"], None),
      Some(token),
    )
  assert created.status == 201
  let data = body(created)
  let id = str(data, ["id"])
  assert string.length(id) == 10
  assert str(data, ["kind"]) == "song"
  assert str(data, ["title"]) == "My Song"
  assert str(data, ["author_id"]) == user_id
  assert str(data, ["author", "handle"]) == "frank"
  assert int_at(data, ["like_count"]) == 0
  assert int_at(data, ["comment_count"]) == 0
  // Tags are lowercased and de-duplicated.
  assert list.length(list_at(data, ["tags"])) == 2
  // Payload round-trips as structured JSON.
  assert int_at(data, ["payload", "bpm"]) == 120
  assert bool_at(data, ["payload", "nested", "ok"]) == True
  assert list.length(list_at(data, ["payload", "notes"])) == 3

  let fetched = get(ctx, "/items/" <> id)
  assert fetched.status == 200
  let fetched_data = body(fetched)
  assert str(fetched_data, ["id"]) == id
  assert str(fetched_data, ["author", "display_name"]) == "User frank"
  assert str(fetched_data, ["created_at"]) == str(data, ["created_at"])

  assert get(ctx, "/items/doesnotexist").status == 404
}

pub fn create_item_validation_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "gina")

  let bad_kind =
    post(ctx, "/items", item_body("podcast", "T", [], None), Some(token))
  assert bad_kind.status == 400
  assert string.contains(error_message(bad_kind), "kind")

  let empty_title =
    post(ctx, "/items", item_body("song", "   ", [], None), Some(token))
  assert empty_title.status == 400
  assert string.contains(error_message(empty_title), "title")

  let missing_payload =
    post(
      ctx,
      "/items",
      json.object([
        #("kind", json.string("song")),
        #("title", json.string("T")),
      ]),
      Some(token),
    )
  assert missing_payload.status == 400
  assert string.contains(error_message(missing_payload), "payload")

  let bad_parent =
    post(
      ctx,
      "/items",
      item_body("song", "T", [], Some("nope123456")),
      Some(token),
    )
  assert bad_parent.status == 400
  assert string.contains(error_message(bad_parent), "parent_id")
}

pub fn payload_too_large_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "hank")
  // ~2.2 MB body: exceeds the 2 MB payload limit.
  let big = string.repeat("a", 2_200_000)
  let text =
    "{\"kind\":\"song\",\"title\":\"big\",\"payload\":\"" <> big <> "\"}"
  let response =
    simulate.request(http.Post, "/items")
    |> simulate.string_body(text)
    |> simulate.header("content-type", "application/json")
    |> with_token(Some(token))
    |> send(ctx, _)
  assert response.status == 413
  assert string.contains(error_message(response), "too large")
}

pub fn list_items_filters_test() {
  let ctx = new_ctx()
  let #(token_a, user_a) = register(ctx, "ivy")
  let #(token_b, _user_b) = register(ctx, "jack")

  let s1 = create_item(ctx, token_a, "song", "Sunrise Groove", ["lofi"], None)
  let _s2 = create_item(ctx, token_a, "song", "Midnight Drive", ["synth"], None)
  let p1 = create_item(ctx, token_b, "preset", "Warm Pad", ["synth"], None)
  let _t1 = create_item(ctx, token_b, "theme", "Neon Sunrise", [], None)

  let all = body(get(ctx, "/items"))
  assert int_at(all, ["total"]) == 4
  assert list.length(list_at(all, ["items"])) == 4
  assert int_at(all, ["page"]) == 1
  assert int_at(all, ["per_page"]) == 20
  // Newest first.
  let first = list.first(list_at(all, ["items"]))
  let assert Ok(first) = first
  assert str(first, ["title"]) == "Neon Sunrise"
  assert str(first, ["author", "handle"]) == "jack"

  let songs = body(get(ctx, "/items?kind=song"))
  assert int_at(songs, ["total"]) == 2

  let by_q = body(get(ctx, "/items?q=SUNRISE"))
  assert int_at(by_q, ["total"]) == 2

  let by_q_desc = body(get(ctx, "/items?q=description%20of%20warm"))
  assert int_at(by_q_desc, ["total"]) == 1

  let by_tag = body(get(ctx, "/items?tag=synth"))
  assert int_at(by_tag, ["total"]) == 2

  let by_author = body(get(ctx, "/items?author=" <> user_a))
  assert int_at(by_author, ["total"]) == 2

  let combined = body(get(ctx, "/items?kind=song&tag=lofi"))
  assert int_at(combined, ["total"]) == 1
  let assert Ok(only) = list.first(list_at(combined, ["items"]))
  assert str(only, ["id"]) == s1

  // Pagination.
  let page2 = body(get(ctx, "/items?per_page=3&page=2"))
  assert int_at(page2, ["total"]) == 4
  assert int_at(page2, ["page"]) == 2
  assert int_at(page2, ["per_page"]) == 3
  assert list.length(list_at(page2, ["items"])) == 1

  // Invalid params.
  assert get(ctx, "/items?sort=hot").status == 400
  assert get(ctx, "/items?page=0").status == 400
  assert get(ctx, "/items?kind=video").status == 400

  // sort=top orders by like_count.
  let _ = post(ctx, "/items/" <> p1 <> "/like", json.null(), Some(token_a))
  let _ = post(ctx, "/items/" <> p1 <> "/like", json.null(), Some(token_b))
  let _ = post(ctx, "/items/" <> s1 <> "/like", json.null(), Some(token_b))
  let top = list_at(body(get(ctx, "/items?sort=top")), ["items"])
  let assert [top1, top2, ..] = top
  assert str(top1, ["id"]) == p1
  assert int_at(top1, ["like_count"]) == 2
  assert str(top2, ["id"]) == s1
}

pub fn patch_item_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "kim")
  let #(other_token, _) = register(ctx, "lee")
  let id = create_item(ctx, token, "preset", "Original", ["a"], None)

  let patched =
    send_json(
      ctx,
      http.Patch,
      "/items/" <> id,
      json.object([
        #("title", json.string("Renamed")),
        #("tags", json.array(["b", "c"], json.string)),
        #("payload", json.object([#("v", json.int(2))])),
      ]),
      Some(token),
    )
  assert patched.status == 200
  let data = body(patched)
  assert str(data, ["title"]) == "Renamed"
  assert str(data, ["description"]) == "Description of Original"
  assert list.length(list_at(data, ["tags"])) == 2
  assert int_at(data, ["payload", "v"]) == 2

  // Only the author may edit.
  let forbidden =
    send_json(
      ctx,
      http.Patch,
      "/items/" <> id,
      json.object([#("title", json.string("Hijacked"))]),
      Some(other_token),
    )
  assert forbidden.status == 403

  let unauthenticated =
    send_json(
      ctx,
      http.Patch,
      "/items/" <> id,
      json.object([#("title", json.string("Hijacked"))]),
      None,
    )
  assert unauthenticated.status == 401

  let invalid =
    send_json(
      ctx,
      http.Patch,
      "/items/" <> id,
      json.object([#("title", json.string(""))]),
      Some(token),
    )
  assert invalid.status == 400
}

pub fn delete_item_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "mia")
  let #(other_token, _) = register(ctx, "ned")
  let id = create_item(ctx, token, "loop", "Loop", [], None)

  assert delete(ctx, "/items/" <> id, Some(other_token)).status == 403
  assert delete(ctx, "/items/" <> id, None).status == 401
  assert delete(ctx, "/items/" <> id, Some(token)).status == 204
  assert get(ctx, "/items/" <> id).status == 404
  assert delete(ctx, "/items/" <> id, Some(token)).status == 404
  assert int_at(body(get(ctx, "/items")), ["total"]) == 0
}

pub fn remixes_and_chain_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "olga")
  let root = create_item(ctx, token, "song", "Root", [], None)
  let child = create_item(ctx, token, "song", "Child", [], Some(root))
  let grandchild =
    create_item(ctx, token, "song", "Grandchild", [], Some(child))
  let sibling = create_item(ctx, token, "song", "Sibling", [], Some(root))

  // Detail embeds the parent.
  let child_data = body(get(ctx, "/items/" <> child))
  assert str(child_data, ["parent_id"]) == root
  assert str(child_data, ["parent", "title"]) == "Root"

  let remixes =
    list_at(body(get(ctx, "/items/" <> root <> "/remixes")), ["items"])
  assert list.length(remixes) == 2
  let remix_ids = list.map(remixes, str(_, ["id"]))
  assert list.contains(remix_ids, child)
  assert list.contains(remix_ids, sibling)
  assert !list.contains(remix_ids, grandchild)

  let chain =
    list_at(body(get(ctx, "/items/" <> grandchild <> "/chain")), ["chain"])
  assert list.map(chain, str(_, ["id"])) == [root, child, grandchild]

  let root_chain =
    list_at(body(get(ctx, "/items/" <> root <> "/chain")), ["chain"])
  assert list.length(root_chain) == 1

  assert get(ctx, "/items/missing123/remixes").status == 404
  assert get(ctx, "/items/missing123/chain").status == 404

  // Deleting the parent detaches children rather than orphaning them.
  assert delete(ctx, "/items/" <> child, Some(token)).status == 204
  let detached = body(get(ctx, "/items/" <> grandchild))
  assert decode.run(
      detached,
      decode.at(["parent_id"], decode.optional(decode.string)),
    )
    == Ok(None)
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

pub fn like_unlike_idempotent_test() {
  let ctx = new_ctx()
  let #(token_a, _) = register(ctx, "pat")
  let #(token_b, _) = register(ctx, "quinn")
  let id = create_item(ctx, token_a, "theme", "Theme", [], None)
  let path = "/items/" <> id <> "/like"

  assert post(ctx, path, json.null(), None).status == 401

  let first = post(ctx, path, json.null(), Some(token_a))
  assert first.status == 200
  assert bool_at(body(first), ["liked"]) == True
  assert int_at(body(first), ["like_count"]) == 1

  // Liking twice does not double count.
  let again = post(ctx, path, json.null(), Some(token_a))
  assert int_at(body(again), ["like_count"]) == 1

  let second_user = post(ctx, path, json.null(), Some(token_b))
  assert int_at(body(second_user), ["like_count"]) == 2
  assert int_at(body(get(ctx, "/items/" <> id)), ["like_count"]) == 2

  let unlike = delete(ctx, path, Some(token_a))
  assert unlike.status == 200
  assert bool_at(body(unlike), ["liked"]) == False
  assert int_at(body(unlike), ["like_count"]) == 1

  // Unliking twice is a no-op.
  let unlike_again = delete(ctx, path, Some(token_a))
  assert int_at(body(unlike_again), ["like_count"]) == 1

  assert post(ctx, "/items/nothere000/like", json.null(), Some(token_a)).status
    == 404
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

pub fn comments_test() {
  let ctx = new_ctx()
  let #(token_a, _) = register(ctx, "rosa")
  let #(token_b, _) = register(ctx, "sam")
  let id = create_item(ctx, token_a, "tutorial", "Tutorial", [], None)
  let path = "/items/" <> id <> "/comments"

  let empty = body(get(ctx, path))
  assert list_at(empty, ["comments"]) == []

  assert post(ctx, path, json.object([#("body", json.string("hi"))]), None).status
    == 401

  let too_short =
    post(ctx, path, json.object([#("body", json.string("   "))]), Some(token_a))
  assert too_short.status == 400

  let too_long =
    post(
      ctx,
      path,
      json.object([#("body", json.string(string.repeat("x", 2001)))]),
      Some(token_a),
    )
  assert too_long.status == 400

  let c1 =
    post(
      ctx,
      path,
      json.object([#("body", json.string("First!"))]),
      Some(token_a),
    )
  assert c1.status == 201
  let c1_id = str(body(c1), ["id"])
  assert str(body(c1), ["body"]) == "First!"
  assert str(body(c1), ["author", "handle"]) == "rosa"

  let c2 =
    post(
      ctx,
      path,
      json.object([#("body", json.string("Second"))]),
      Some(token_b),
    )
  assert c2.status == 201
  let c2_id = str(body(c2), ["id"])

  let listed = list_at(body(get(ctx, path)), ["comments"])
  assert list.map(listed, str(_, ["id"])) == [c1_id, c2_id]
  assert int_at(body(get(ctx, "/items/" <> id)), ["comment_count"]) == 2

  // Only the author may delete.
  assert delete(ctx, "/comments/" <> c1_id, Some(token_b)).status == 403
  assert delete(ctx, "/comments/" <> c1_id, None).status == 401
  assert delete(ctx, "/comments/" <> c1_id, Some(token_a)).status == 204
  assert delete(ctx, "/comments/" <> c1_id, Some(token_a)).status == 404
  assert int_at(body(get(ctx, "/items/" <> id)), ["comment_count"]) == 1

  assert get(ctx, "/items/nothere000/comments").status == 404
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

pub fn share_link_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "tess")
  let id = create_item(ctx, token, "preset", "Shareable", [], None)

  let first = post(ctx, "/items/" <> id <> "/share", json.null(), None)
  assert first.status == 200
  let code = str(body(first), ["code"])
  assert string.length(code) == 6
  assert str(body(first), ["url"]) == "https://wisp.example.com/s/" <> code

  // Same item -> same code.
  let second = post(ctx, "/items/" <> id <> "/share", json.null(), None)
  assert str(body(second), ["code"]) == code

  let redirect = get(ctx, "/s/" <> code)
  assert redirect.status == 302
  assert header(redirect, "location")
    == Ok("http://localhost:5173/preset/" <> id)
  assert header(redirect, "cross-origin-resource-policy") == Ok("cross-origin")

  assert get(ctx, "/s/zzzzzz").status == 404
  assert post(ctx, "/items/nothere000/share", json.null(), None).status == 404
}

pub fn share_redirect_uses_frontend_origin_test() {
  let assert Ok(store) = memory.new()
  let ctx =
    Context(
      store:,
      config: config.Config(
        ..config.default(),
        frontend_origin: "https://gesture-synth.app",
      ),
    )
  let #(token, _) = register(ctx, "uma")
  let id = create_item(ctx, token, "loop", "Loop", [], None)
  let code =
    str(body(post(ctx, "/items/" <> id <> "/share", json.null(), None)), [
      "code",
    ])
  assert header(get(ctx, "/s/" <> code), "location")
    == Ok("https://gesture-synth.app/loop/" <> id)
}

// ---------------------------------------------------------------------------
// Stage boards
// ---------------------------------------------------------------------------

fn score_body(
  song: String,
  score: Int,
  rating: String,
  variations: List(String),
) -> Json {
  json.object([
    #("song_id", json.string(song)),
    #("score", json.int(score)),
    #("accuracy", json.float(0.9)),
    #("run", json.int(12)),
    #("rating", json.string(rating)),
    #("variations", json.array(variations, json.string)),
  ])
}

pub fn scores_require_auth_test() {
  let ctx = new_ctx()
  let response =
    post(ctx, "/scores", score_body("four-chords", 1000, "tight", []), None)
  assert response.status == 401
}

pub fn scores_validation_test() {
  let ctx = new_ctx()
  let #(token, _) = register(ctx, "scorer")
  let bad_rating =
    post(
      ctx,
      "/scores",
      score_body("four-chords", 1000, "legendary", []),
      Some(token),
    )
  assert bad_rating.status == 400
  assert string.contains(error_message(bad_rating), "rating")
  let bad_variation =
    post(
      ctx,
      "/scores",
      score_body("four-chords", 1000, "tight", ["turbo"]),
      Some(token),
    )
  assert bad_variation.status == 400
  let rehearsal =
    post(
      ctx,
      "/scores",
      score_body("four-chords", 1000, "tight", ["rehearsal"]),
      Some(token),
    )
  assert rehearsal.status == 400
  assert string.contains(error_message(rehearsal), "rehearsal")
  let missing_song = get_auth(ctx, "/scores", token)
  assert missing_song.status == 400
  let huge =
    post(
      ctx,
      "/scores",
      score_body("four-chords", 999_999_999, "tight", []),
      Some(token),
    )
  assert huge.status == 400
}

pub fn scores_board_is_best_per_player_test() {
  let ctx = new_ctx()
  let #(a, a_id) = register(ctx, "alpha")
  let #(b, b_id) = register(ctx, "bravo")
  assert post(
      ctx,
      "/scores",
      score_body("four-chords", 900, "steady", []),
      Some(a),
    ).status
    == 201
  assert post(
      ctx,
      "/scores",
      score_body("four-chords", 1500, "pocket", ["strict"]),
      Some(a),
    ).status
    == 201
  assert post(
      ctx,
      "/scores",
      score_body("four-chords", 1200, "tight", []),
      Some(b),
    ).status
    == 201
  // another song must not leak in
  assert post(
      ctx,
      "/scores",
      score_body("brass-tacks", 5000, "flawless", []),
      Some(b),
    ).status
    == 201

  let response = get(ctx, "/scores?song=four-chords&limit=10")
  assert response.status == 200
  let scores = list_at(body(response), ["scores"])
  assert list.length(scores) == 2
  let assert [first, second] = scores
  assert str(first, ["user_id"]) == a_id
  assert int_at(first, ["score"]) == 1500
  assert str(first, ["author", "handle"]) == "alpha"
  assert str(second, ["user_id"]) == b_id
  assert int_at(second, ["score"]) == 1200

  let limited = get(ctx, "/scores?song=four-chords&limit=1")
  assert list.length(list_at(body(limited), ["scores"])) == 1

  let wrong_method = delete(ctx, "/scores", Some(a))
  assert wrong_method.status == 405
}
