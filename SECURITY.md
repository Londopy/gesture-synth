# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

Only the latest minor release receives fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on
https://github.com/Londopy/gesture-synth. If that is unavailable, email the
maintainer at the address on the GitHub profile with "gesture-synth security"
in the subject.

Include what you found, how to reproduce it, and the impact you expect. You
will get an acknowledgement within 7 days and a fix or a plan within 30 days
for confirmed issues. Credit is given in the changelog unless you prefer not.

## What is in scope

- The community service (`services/community`): authentication, authorization (author-only edits), input validation, payload size limits, CORS.
- The desktop shell (`src-tauri`): Tauri commands that touch the filesystem (`read_file`, `write_file`, `save_bytes`, ...), the ffmpeg sidecar invocation, deep-link handling.
- The web app: handling of untrusted `.gsyn.json` files and community payloads, service worker caching, the ffmpeg.wasm loader.
- The Rust core: parsing of untrusted session, song, instrument and theme files.

## What the app does with your data

- Camera frames are processed locally by MediaPipe in the page or webview. The clear camera view shows the raw picture on your screen only.
- The microphone is opened only while you record with the mic option on, and the stream is closed when the recording stops. Recordings are saved where you choose; nothing is uploaded. No video or landmarks leave the device unless you explicitly publish a loop, which includes 15 Hz hand landmarks for ghost playback.
- Audio is synthesized locally. Nothing is uploaded unless you use Share or Publish.
- Telemetry is off by default and this build sends none.
- The community service stores handles, display names, PBKDF2 password hashes, hashed session tokens and the items you publish. Passwords and raw tokens are never stored.

## Hardening notes for operators of the community service

- Run behind TLS; the service itself speaks plain HTTP.
- Set `CORS_ORIGIN` to your frontend origin instead of the default `*`.
- Set a strong `SECRET_KEY_BASE`.
- The 2 MB body limit is enforced by wisp; keep a reverse-proxy limit too.
- There is no rate limiting in the service; add it at the proxy.
