//// Random identifier generation. All IDs are short, URL-safe strings derived
//// from cryptographically strong random bytes.

import gleam/bit_array
import gleam/crypto
import gleam/string

/// Length of entity IDs (users, items, comments).
pub const id_length = 10

/// Length of share codes used in `/s/:code` URLs.
pub const short_code_length = 6

/// A fresh 10-character URL-safe ID.
pub fn new_id() -> String {
  random_urlsafe(id_length)
}

/// A fresh 6-character URL-safe share code.
pub fn new_short_code() -> String {
  random_urlsafe(short_code_length)
}

/// A fresh session token: 32 random bytes, base64url encoded without padding.
pub fn new_token() -> String {
  crypto.strong_random_bytes(32)
  |> bit_array.base64_url_encode(False)
}

fn random_urlsafe(length: Int) -> String {
  // base64url of n bytes yields ceil(4n/3) >= n characters, so slicing to
  // `length` always succeeds.
  crypto.strong_random_bytes(length)
  |> bit_array.base64_url_encode(False)
  |> string.slice(0, length)
}
