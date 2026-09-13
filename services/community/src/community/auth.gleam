//// Authentication: password hashing (PBKDF2-HMAC-SHA256), bearer session
//// tokens, input validation and the /auth/* and /me handlers.

import community/ids
import community/json_codec
import community/store.{type User, Session, User}
import community/web.{type AppError, type Context, BadRequest, Unauthorized}
import gleam/bit_array
import gleam/crypto
import gleam/http/request
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import gleam/string
import gleam/time/timestamp
import wisp.{type Request, type Response}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/// PBKDF2 iteration count for newly created hashes. Stored alongside each
/// hash so it can be raised later without invalidating existing accounts.
pub const pbkdf2_iterations = 100_000

const salt_bytes = 16

/// Hash a password with PBKDF2-HMAC-SHA256 and a fresh random salt.
/// Format: `pbkdf2-sha256$<iterations>$<salt b64>$<derived key b64>`.
pub fn hash_password(password: String) -> String {
  let salt = crypto.strong_random_bytes(salt_bytes)
  let key =
    pbkdf2_sha256(bit_array.from_string(password), salt, pbkdf2_iterations)
  string.join(
    [
      "pbkdf2-sha256",
      int.to_string(pbkdf2_iterations),
      bit_array.base64_encode(salt, True),
      bit_array.base64_encode(key, True),
    ],
    "$",
  )
}

/// Verify a password against a stored hash in constant time.
pub fn verify_password(password: String, stored: String) -> Bool {
  case string.split(stored, "$") {
    ["pbkdf2-sha256", iterations, salt, expected] -> {
      case
        int.parse(iterations),
        bit_array.base64_decode(salt),
        bit_array.base64_decode(expected)
      {
        Ok(iterations), Ok(salt), Ok(expected)
          if iterations > 0 && iterations <= 10_000_000
        -> {
          let actual =
            pbkdf2_sha256(bit_array.from_string(password), salt, iterations)
          crypto.secure_compare(actual, expected)
        }
        _, _, _ -> False
      }
    }
    _ -> False
  }
}

/// PBKDF2 with HMAC-SHA256 producing a single 32-byte block (dkLen = hLen),
/// per RFC 8018 section 5.2.
fn pbkdf2_sha256(
  password: BitArray,
  salt: BitArray,
  iterations: Int,
) -> BitArray {
  let u1 = crypto.hmac(<<salt:bits, 1:size(32)>>, crypto.Sha256, password)
  pbkdf2_loop(password, u1, u1, iterations - 1)
}

fn pbkdf2_loop(
  password: BitArray,
  previous: BitArray,
  accumulator: BitArray,
  remaining: Int,
) -> BitArray {
  case remaining <= 0 {
    True -> accumulator
    False -> {
      let next = crypto.hmac(previous, crypto.Sha256, password)
      pbkdf2_loop(password, next, xor_bytes(accumulator, next), remaining - 1)
    }
  }
}

/// XOR two equal-length bit arrays whose length is a multiple of 8 bytes.
fn xor_bytes(a: BitArray, b: BitArray) -> BitArray {
  case a, b {
    <<x:size(64), rest_a:bits>>, <<y:size(64), rest_b:bits>> -> {
      let z = int.bitwise_exclusive_or(x, y)
      let tail = xor_bytes(rest_a, rest_b)
      <<z:size(64), tail:bits>>
    }
    _, _ -> <<>>
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// SHA-256 digest of a bearer token, hex encoded. Only this is stored.
pub fn hash_token(token: String) -> String {
  crypto.hash(crypto.Sha256, bit_array.from_string(token))
  |> bit_array.base16_encode
  |> string.lowercase
}

/// Extract the bearer token from the `Authorization` header.
pub fn bearer_token(request: Request) -> Result(String, Nil) {
  use header <- result.try(request.get_header(request, "authorization"))
  case string.split_once(string.trim(header), " ") {
    Ok(#(scheme, token)) ->
      case string.lowercase(scheme), string.trim(token) {
        "bearer", "" -> Error(Nil)
        "bearer", token -> Ok(token)
        _, _ -> Error(Nil)
      }
    _ -> Error(Nil)
  }
}

/// Resolve the authenticated user for a request, or 401.
pub fn authenticate(ctx: Context, request: Request) -> Result(User, AppError) {
  use token <- result.try(
    bearer_token(request)
    |> result.replace_error(Unauthorized("missing bearer token")),
  )
  ctx.store.get_session_user(hash_token(token))
  |> result.map_error(fn(error) {
    case error {
      store.NotFound -> Unauthorized("invalid or expired token")
      other -> web.store_error(other, "session not found")
    }
  })
}

fn start_session(ctx: Context, user: User) -> Result(String, AppError) {
  let token = ids.new_token()
  let session =
    Session(
      token_hash: hash_token(token),
      user_id: user.id,
      created_at: timestamp.system_time(),
    )
  ctx.store.insert_session(session)
  |> result.map_error(web.store_error(_, "user not found"))
  |> result.replace(token)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const handle_alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_"

/// Handles are normalised to lowercase and must be 3-24 chars of [a-z0-9_].
pub fn validate_handle(handle: String) -> Result(String, AppError) {
  let handle = handle |> string.trim |> string.lowercase
  let length = string.length(handle)
  let allowed =
    string.to_graphemes(handle)
    |> list.all(string.contains(handle_alphabet, _))
  case length >= 3 && length <= 24, allowed {
    True, True -> Ok(handle)
    _, _ ->
      Error(BadRequest(
        "handle must be 3-24 characters of lowercase letters, digits or underscore",
      ))
  }
}

pub fn validate_display_name(name: String) -> Result(String, AppError) {
  web.check_length(name, "display_name", 1, 64)
}

pub fn validate_password(password: String) -> Result(String, AppError) {
  let length = string.length(password)
  case length >= 8, length <= 128 {
    True, True -> Ok(password)
    False, _ -> Error(BadRequest("password must be at least 8 characters"))
    _, False -> Error(BadRequest("password must be at most 128 characters"))
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /auth/register { handle, display_name, password } -> 201 { token, user }
pub fn register(ctx: Context, request: Request) -> Response {
  web.respond({
    use body <- result.try(web.read_json(request, json_codec.register_decoder()))
    use handle <- result.try(validate_handle(body.handle))
    use display_name <- result.try(validate_display_name(body.display_name))
    use password <- result.try(validate_password(body.password))

    let user =
      User(
        id: ids.new_id(),
        handle:,
        display_name:,
        password_hash: hash_password(password),
        created_at: timestamp.system_time(),
      )
    use user <- result.try(
      ctx.store.insert_user(user)
      |> result.map_error(fn(error) {
        case error {
          store.Conflict(_) -> web.Conflict("handle is already taken")
          other -> web.store_error(other, "user not found")
        }
      }),
    )
    use token <- result.try(start_session(ctx, user))
    Ok(web.json(201, session_json(token, user)))
  })
}

/// POST /auth/login { handle, password } -> { token, user }
pub fn login(ctx: Context, request: Request) -> Response {
  web.respond({
    use body <- result.try(web.read_json(request, json_codec.login_decoder()))
    let handle = body.handle |> string.trim |> string.lowercase
    let invalid = Unauthorized("invalid handle or password")

    use user <- result.try(
      ctx.store.get_user_by_handle(handle)
      |> result.map_error(fn(error) {
        case error {
          store.NotFound -> invalid
          other -> web.store_error(other, "user not found")
        }
      }),
    )
    use _ <- result.try(
      case verify_password(body.password, user.password_hash) {
        True -> Ok(Nil)
        False -> Error(invalid)
      },
    )
    use token <- result.try(start_session(ctx, user))
    Ok(web.json(200, session_json(token, user)))
  })
}

/// POST /auth/logout (auth) -> 204
pub fn logout(ctx: Context, request: Request) -> Response {
  web.respond({
    use _ <- result.try(authenticate(ctx, request))
    let assert Ok(token) = bearer_token(request)
    use _ <- result.try(
      ctx.store.delete_session(hash_token(token))
      |> result.map_error(web.store_error(_, "session not found")),
    )
    Ok(wisp.no_content())
  })
}

/// GET /me (auth) -> user
pub fn me(ctx: Context, request: Request) -> Response {
  web.respond({
    use user <- result.try(authenticate(ctx, request))
    Ok(web.json(200, json_codec.user(user)))
  })
}

fn session_json(token: String, user: User) -> json.Json {
  json.object([
    #("token", json.string(token)),
    #("user", json_codec.user(user)),
  ])
}
