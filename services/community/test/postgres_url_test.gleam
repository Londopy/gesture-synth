import community/store/postgres
import gleam/option
import gleeunit/should

// Neon's connection string: no port, sslmode=require. The port is added and
// require becomes verify-full so pog sends SNI (Neon routes on it).
pub fn neon_url_gets_port_and_verify_full_test() {
  postgres.normalise_url(
    "postgresql://user:pw@ep-cool-name-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  )
  |> should.equal(
    "postgresql://user:pw@ep-cool-name-pooler.us-east-2.aws.neon.tech:5432/neondb?sslmode=verify-full&channel_binding=require",
  )
}

pub fn neon_endpoint_is_the_first_host_label_test() {
  postgres.neon_endpoint(
    "postgresql://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/neondb",
  )
  |> should.equal(option.Some("ep-cool-name-pooler"))
  postgres.neon_endpoint("postgres://u:p@db.example.com/x")
  |> should.equal(option.None)
}

// Render / Supabase style: no port, no query at all -> verified TLS.
pub fn hosted_url_without_query_gets_sslmode_test() {
  postgres.normalise_url("postgres://u:p@dpg-abc.oregon-postgres.render.com/db")
  |> should.equal(
    "postgres://u:p@dpg-abc.oregon-postgres.render.com:5432/db?sslmode=verify-full",
  )
}

// A local sslmode=require is left as it is (self-signed dev certs).
pub fn local_sslmode_require_is_kept_test() {
  postgres.normalise_url("postgres://u:p@localhost:5432/x?sslmode=require")
  |> should.equal("postgres://u:p@localhost:5432/x?sslmode=require")
}

// Local development stays plain.
pub fn localhost_url_is_left_alone_test() {
  postgres.normalise_url("postgres://u:p@localhost:5432/community")
  |> should.equal("postgres://u:p@localhost:5432/community")
}

pub fn localhost_without_port_only_gets_the_port_test() {
  postgres.normalise_url("postgres://u:p@127.0.0.1/community")
  |> should.equal("postgres://u:p@127.0.0.1:5432/community")
}

// An explicit sslmode=disable is respected.
pub fn explicit_sslmode_is_not_overridden_test() {
  postgres.normalise_url("postgres://u:p@db.example.com:6543/x?sslmode=disable")
  |> should.equal("postgres://u:p@db.example.com:6543/x?sslmode=disable")
}

// Garbage passes through untouched so pog reports the real parse error.
pub fn unparseable_string_passes_through_test() {
  postgres.normalise_url("not a url") |> should.equal("not a url")
}
