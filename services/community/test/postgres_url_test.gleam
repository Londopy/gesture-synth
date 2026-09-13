import community/store/postgres
import gleeunit/should

// Neon's connection string: no port, sslmode already present.
pub fn neon_url_keeps_sslmode_and_adds_port_test() {
  postgres.normalise_url(
    "postgresql://user:pw@ep-cool-name-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  )
  |> should.equal(
    "postgresql://user:pw@ep-cool-name-pooler.us-east-2.aws.neon.tech:5432/neondb?sslmode=require&channel_binding=require",
  )
}

// Render / Supabase style: no port, no query at all -> TLS is required.
pub fn hosted_url_without_query_gets_sslmode_test() {
  postgres.normalise_url("postgres://u:p@dpg-abc.oregon-postgres.render.com/db")
  |> should.equal(
    "postgres://u:p@dpg-abc.oregon-postgres.render.com:5432/db?sslmode=require",
  )
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
