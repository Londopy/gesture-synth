# Community service: multi-stage build to a small Erlang runtime image.
FROM ghcr.io/gleam-lang/gleam:v1.18.1-erlang-alpine AS build
WORKDIR /app
COPY gleam.toml manifest.toml ./
RUN gleam deps download
COPY src ./src
COPY sql ./sql
RUN gleam export erlang-shipment

# Run on the same image the code was compiled with. A runtime OTP older than the
# build OTP refuses to load the .beam files, which surfaces as
# "undef community@@main:run" at boot.
FROM ghcr.io/gleam-lang/gleam:v1.18.1-erlang-alpine
# CA bundle for verified TLS to hosted Postgres (sslmode=verify-full).
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /app/build/erlang-shipment ./
# The service applies this idempotent schema on startup when DATABASE_URL is set.
COPY --from=build /app/sql ./sql
ENV PORT=8787
EXPOSE 8787
# Gleam 1.18 emits license comments above the shebang in entrypoint.sh, so the
# kernel cannot exec it directly ("exec format error"); run it through sh.
CMD ["sh", "./entrypoint.sh", "run"]
