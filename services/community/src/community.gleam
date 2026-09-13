//// Gesture Synth "Community" service entry point.
////
//// Starts an HTTP server (wisp on mist) backed by either the in-memory store
//// (default) or Postgres (when `DATABASE_URL` is set).

import community/config
import community/router
import community/store.{type Store}
import community/store/memory
import community/store/postgres
import community/web.{Context}
import gleam/erlang/process
import gleam/int
import gleam/io
import gleam/option.{None, Some}
import gleam/string
import mist
import wisp
import wisp/wisp_mist

pub fn main() -> Nil {
  wisp.configure_logger()
  let config = config.load()

  let store = case config.database_url {
    None -> start_memory_store()
    Some(url) -> start_postgres_store(url)
  }
  let ctx = Context(store:, config:)

  io.println(
    "community: store="
    <> store.kind
    <> " frontend_origin="
    <> config.frontend_origin
    <> " cors_origin="
    <> config.cors_origin,
  )

  io.println("community: listening on port " <> int.to_string(config.port))
  let assert Ok(_) =
    router.handle_request(_, ctx)
    |> wisp_mist.handler(config.secret_key_base)
    |> mist.new
    |> mist.bind("0.0.0.0")
    |> mist.port(config.port)
    |> mist.start
    as "could not start the HTTP server (is the port already in use?)"

  process.sleep_forever()
}

fn start_memory_store() -> Store {
  let assert Ok(store) = memory.new() as "could not start the in-memory store"
  store
}

fn start_postgres_store(url: String) -> Store {
  case postgres.new(url) {
    Ok(store) -> store
    Error(reason) -> panic as { "postgres: " <> string.trim(reason) }
  }
}
