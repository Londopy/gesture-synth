<!-- Filled in by .github/workflows/release.yml. {{CHANGES}} comes from CHANGELOG.md via patchnotes. -->

{{CHANGES}}

---

## Downloads

| File | What it is |
| --- | --- |
| `Gesture.Synth_*_x64-setup.exe` / `Gesture.Synth_*_x64_en-US.msi` | Windows installer (WebView2, 64-bit) |
| `Gesture.Synth_*_amd64.AppImage` / `.deb` / `.rpm` | Linux |
| `Gesture.Synth_*_aarch64.dmg` | macOS, Apple Silicon (only present when the opt-in Mac build has been run) |
| `gesture-synth-web-{{TAG}}.zip` | The website, to run on your own computer at `http://localhost:4173` |
| `SHA256SUMS.txt` | Checksums for every file above |

## Install

### Windows

1. Download the `.msi` (or the `-setup.exe`).
2. Double-click it. Windows SmartScreen may say "Windows protected your PC" because the installer is not code-signed: click **More info**, then **Run anyway**.
3. Start **Gesture Synth** from the Start menu. Allow the camera when asked. Press `H` for the gesture cheat sheet.

### macOS

There is no prebuilt Mac app (hosted macOS build machines were unreliable). Two options:

- Use the website zip below; it runs the same instrument in Safari, Chrome or Firefox.
- If a `_aarch64.dmg` is attached to this release, use it (Apple Silicon only): open it, drag **Gesture Synth** to Applications, then right-click › **Open** the first time (the app is not notarized) or run `xattr -cr "/Applications/Gesture Synth.app"`.
- Otherwise build the app yourself in about ten minutes: install [Rust](https://rustup.rs), [Node](https://nodejs.org) and Xcode command line tools (`xcode-select --install`), then
  ```bash
  git clone https://github.com/{{REPO}}.git && cd gesture-synth
  npm install && npm run models && npm run tauri:build
  ```
  The `.app` and `.dmg` land in `target/release/bundle/`. Grant camera access on first launch.

### Linux

```bash
chmod +x Gesture.Synth_*_amd64.AppImage && ./Gesture.Synth_*_amd64.AppImage
```
or `sudo dpkg -i Gesture.Synth_*_amd64.deb`. The app needs webkit2gtk 4.1 and ALSA.

### Run the website locally (any OS)

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
unzip gesture-synth-web-{{TAG}}.zip -d gesture-synth-web
cd gesture-synth-web
node serve.mjs
```

Then open **http://localhost:4173** in Chrome, Edge or Firefox and click **Start**. The server sends the cross-origin isolation headers, so you get the same low-latency audio path as the hosted site. Everything runs on your machine; nothing is uploaded.

## Verify a download

```bash
# Linux / macOS
sha256sum -c SHA256SUMS.txt --ignore-missing
# Windows PowerShell
Get-FileHash .\Gesture.Synth_*_x64_en-US.msi -Algorithm SHA256
```

Compare the Windows hash with the line for that file in `SHA256SUMS.txt`.

## First steps

- Left hand: index finger up = **I**, add fingers for II, III, IV, all five = V. Tilt the palm inward for major, outward for minor.
- Right hand: one finger = triad, two = first inversion, three = seventh, four = dom7. Tilt for filter, height for volume.
- `R` records a loop (one bar count-in), `Space` plays/stops, `C` switches to the clear camera view, `Ctrl/Cmd+Shift+R` records a video.

Full docs: [README](https://github.com/{{REPO}}#readme) · [Changelog](https://github.com/{{REPO}}/blob/main/CHANGELOG.md) · [Report a problem](https://github.com/{{REPO}}/issues/new/choose)
