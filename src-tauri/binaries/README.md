# ffmpeg sidecar

Tauri bundles `ffmpeg-<target-triple>[.exe]` from this folder as a sidecar
(spec 2 "Video export"). It is not checked in. Fetch one for your platform:

    node scripts/fetch-ffmpeg.mjs

which downloads a static build and renames it to e.g.
`ffmpeg-x86_64-pc-windows-msvc.exe`. If no sidecar is present the app falls
back to an `ffmpeg` on PATH, and if that is missing too, mp4 export is hidden
and webm (MediaRecorder) is used.
