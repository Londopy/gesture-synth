#!/usr/bin/env bash
# Build command for the Render static site (see render.yaml).
#
# Render's build image ships a Rust toolchain under /usr/local that is
# read-only at build time, so `rustup target add wasm32-unknown-unknown`
# cannot touch it and a plain rustup-init refuses to run beside it. Installing
# a private toolchain into $HOME sidesteps both.
set -euo pipefail

export RUSTUP_HOME="$HOME/.rustup"
export CARGO_HOME="$HOME/.cargo"
export RUSTUP_INIT_SKIP_PATH_CHECK=yes

if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable \
        --target wasm32-unknown-unknown --no-modify-path
fi
export PATH="$CARGO_HOME/bin:$PATH"
rustup target add wasm32-unknown-unknown
cargo --version
rustc --print sysroot

npm ci
node scripts/fetch-models.mjs
npm run build
