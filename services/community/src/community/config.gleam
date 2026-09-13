//// Runtime configuration loaded from environment variables.

import envoy
import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/option.{type Option, None, Some}
import gleam/string

pub type Config {
  Config(
    /// TCP port to listen on. Env `PORT`, default 8787.
    port: Int,
    /// Postgres connection URL. Env `DATABASE_URL`. When unset the in-memory
    /// store is used.
    database_url: Option(String),
    /// Origin of the frontend, used for share-link redirects.
    /// Env `FRONTEND_ORIGIN`, default `http://localhost:5173`.
    frontend_origin: String,
    /// Value for `Access-Control-Allow-Origin`. Env `CORS_ORIGIN`, default `*`.
    cors_origin: String,
    /// Secret used by wisp for signing. Env `SECRET_KEY_BASE`; a random one
    /// is generated when unset (must be at least 64 bytes).
    secret_key_base: String,
  )
}

pub fn load() -> Config {
  let port = case envoy.get("PORT") {
    Ok(value) ->
      case int.parse(string.trim(value)) {
        Ok(port) if port > 0 && port < 65_536 -> port
        _ -> 8787
      }
    Error(_) -> 8787
  }

  let database_url = case envoy.get("DATABASE_URL") {
    Ok(url) if url != "" -> Some(url)
    _ -> None
  }

  let frontend_origin =
    envoy.get("FRONTEND_ORIGIN")
    |> non_empty_or("http://localhost:5173")
    |> string.trim
    |> strip_trailing_slash

  let cors_origin =
    envoy.get("CORS_ORIGIN")
    |> non_empty_or("*")
    |> string.trim

  let secret_key_base = case envoy.get("SECRET_KEY_BASE") {
    Ok(secret) if secret != "" -> pad_secret(secret)
    _ -> random_secret()
  }

  Config(port:, database_url:, frontend_origin:, cors_origin:, secret_key_base:)
}

/// Default configuration for tests and local tooling (memory store).
pub fn default() -> Config {
  Config(
    port: 8787,
    database_url: None,
    frontend_origin: "http://localhost:5173",
    cors_origin: "*",
    secret_key_base: random_secret(),
  )
}

fn non_empty_or(value: Result(String, Nil), default: String) -> String {
  case value {
    Ok(v) if v != "" -> v
    _ -> default
  }
}

fn strip_trailing_slash(origin: String) -> String {
  case string.ends_with(origin, "/") {
    True -> string.drop_end(origin, 1)
    False -> origin
  }
}

/// wisp requires a secret key base of at least 64 bytes. If the operator
/// supplied something shorter we stretch it deterministically with SHA-512
/// rather than crash at startup.
fn pad_secret(secret: String) -> String {
  case string.byte_size(secret) >= 64 {
    True -> secret
    False ->
      crypto.hash(crypto.Sha512, bit_array.from_string(secret))
      |> bit_array.base16_encode
  }
}

fn random_secret() -> String {
  // 48 random bytes -> 64 base64 characters.
  crypto.strong_random_bytes(48)
  |> bit_array.base64_encode(False)
}
