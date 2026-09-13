//// Shared HTTP plumbing: request context, application errors, JSON responses
//// and JSON body parsing.

import community/config.{type Config}
import community/store.{type Store, type StoreError}
import gleam/bit_array
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import wisp.{type Request, type Response}

/// Everything a handler needs: the storage backend and runtime configuration.
pub type Context {
  Context(store: Store, config: Config)
}

pub type AppError {
  BadRequest(String)
  Unauthorized(String)
  Forbidden(String)
  NotFound(String)
  Conflict(String)
  PayloadTooLarge
  Internal(String)
}

/// Max accepted request body: 2 MB payload plus headroom for the JSON envelope.
pub const max_body_bytes = 2_162_688

/// Max size of an item `payload` document, in bytes of its JSON text.
pub const max_payload_bytes = 2_097_152

pub fn json(status: Int, body: Json) -> Response {
  wisp.json_response(json.to_string(body), status)
}

pub fn error_json(message: String) -> Json {
  json.object([#("error", json.string(message))])
}

pub fn error_response(error: AppError) -> Response {
  let #(status, message) = case error {
    BadRequest(message) -> #(400, message)
    Unauthorized(message) -> #(401, message)
    Forbidden(message) -> #(403, message)
    NotFound(message) -> #(404, message)
    Conflict(message) -> #(409, message)
    PayloadTooLarge -> #(413, "request body too large (payload max 2 MB)")
    Internal(detail) -> {
      wisp.log_error("internal error: " <> detail)
      #(500, "internal server error")
    }
  }
  json(status, error_json(message))
}

/// Turn a handler's `Result` into a response.
pub fn respond(result: Result(Response, AppError)) -> Response {
  case result {
    Ok(response) -> response
    Error(error) -> error_response(error)
  }
}

/// Map a storage error to an application error, using `not_found` as the
/// message for `store.NotFound`.
pub fn store_error(error: StoreError, not_found: String) -> AppError {
  case error {
    store.NotFound -> NotFound(not_found)
    store.Conflict(constraint) -> Conflict("conflict on " <> constraint)
    store.Unavailable(reason) -> Internal(reason)
  }
}

/// Read and decode a JSON request body. Produces JSON-shaped errors for
/// oversized, non-UTF-8, malformed or schema-invalid bodies.
pub fn read_json(
  request: Request,
  decoder: decode.Decoder(a),
) -> Result(a, AppError) {
  use bits <- result.try(
    wisp.read_body_bits(request) |> result.replace_error(PayloadTooLarge),
  )
  use text <- result.try(
    bit_array.to_string(bits)
    |> result.replace_error(BadRequest("request body must be UTF-8 text")),
  )
  case json.parse(text, decoder) {
    Ok(value) -> Ok(value)
    Error(json.UnableToDecode(errors)) ->
      Error(BadRequest(describe_decode_errors(errors)))
    Error(_) -> Error(BadRequest("request body is not valid JSON"))
  }
}

fn describe_decode_errors(errors: List(decode.DecodeError)) -> String {
  errors
  |> list.map(fn(error) {
    let decode.DecodeError(expected:, found:, path:) = error
    let location = case path {
      [] -> "body"
      _ -> "field '" <> string.join(path, ".") <> "'"
    }
    location <> ": expected " <> expected <> ", got " <> found
  })
  |> string.join("; ")
}

/// Trim a string and check its grapheme length is within [min, max].
pub fn check_length(
  value: String,
  field: String,
  min: Int,
  max: Int,
) -> Result(String, AppError) {
  let value = string.trim(value)
  let length = string.length(value)
  case length < min, length > max {
    True, _ ->
      Error(BadRequest(
        field
        <> " must be at least "
        <> string.inspect(min)
        <> " character"
        <> plural(min),
      ))
    _, True ->
      Error(BadRequest(
        field
        <> " must be at most "
        <> string.inspect(max)
        <> " character"
        <> plural(max),
      ))
    False, False -> Ok(value)
  }
}

fn plural(n: Int) -> String {
  case n {
    1 -> ""
    _ -> "s"
  }
}
