//! Gesture Synth desktop shell (Tauri 2). Hosts the same Svelte frontend as
//! the web build and adds: a native cpal audio thread, midir MIDI out, the
//! data folder for sessions, the ffmpeg sidecar for mp4, and the gsyn://
//! deep link scheme.

mod audio;

use audio::AudioBackend;
use gsyn_core::engine::{EngineCommand, EngineSettings};
use parking_lot::Mutex;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;

pub struct AppState {
    audio: Mutex<Option<AudioBackend>>,
    midi: Arc<Mutex<Option<midir::MidiOutputConnection>>>,
}

#[derive(Serialize)]
struct AudioInfo {
    device: String,
    sample_rate: u32,
    latency_ms: u32,
}

#[derive(Serialize)]
struct FileInfo {
    name: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
struct DeviceInfo {
    id: String,
    name: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("files");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") {
        return Err("bad file name".into());
    }
    Ok(name.to_string())
}

// ---------------------------------------------------------------- audio

#[tauri::command]
fn native_audio_start(app: AppHandle, state: State<AppState>, settings: Option<String>) -> Result<AudioInfo, String> {
    let mut slot = state.audio.lock();
    if let Some(b) = slot.as_ref() {
        return Ok(AudioInfo { device: b.device_name.clone(), sample_rate: b.sample_rate, latency_ms: b.latency_ms });
    }
    let prefs = read_prefs(&app);
    let device = prefs.get("audioDeviceId").and_then(|v| v.as_str()).map(String::from);
    let buffer = prefs.get("bufferSize").and_then(|v| v.as_u64()).unwrap_or(128) as u32;
    let engine_settings: Option<EngineSettings> = settings.and_then(|s| serde_json::from_str(&s).ok());
    let backend = audio::start(app.clone(), device, buffer, engine_settings, state.midi.clone())?;
    let info = AudioInfo { device: backend.device_name.clone(), sample_rate: backend.sample_rate, latency_ms: backend.latency_ms };
    *slot = Some(backend);
    Ok(info)
}

#[tauri::command]
fn native_audio_stop(state: State<AppState>) {
    state.audio.lock().take();
}

#[tauri::command]
fn native_audio_devices() -> Vec<DeviceInfo> {
    audio::list_output_devices().into_iter().map(|(id, name)| DeviceInfo { id, name }).collect()
}

#[tauri::command]
fn native_set_live(state: State<AppState>, live: Vec<f32>, events: Vec<f32>) -> Result<(), String> {
    let slot = state.audio.lock();
    let b = slot.as_ref().ok_or("audio not started")?;
    b.set_live(&live, &events);
    Ok(())
}

#[tauri::command]
fn native_command(state: State<AppState>, json: String) -> Result<(), String> {
    let cmd: EngineCommand = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let slot = state.audio.lock();
    slot.as_ref().ok_or("audio not started")?.command(cmd);
    Ok(())
}

#[tauri::command]
fn native_call(state: State<AppState>, method: String, args: String) -> Result<serde_json::Value, String> {
    let args: Vec<serde_json::Value> = serde_json::from_str(&args).map_err(|e| e.to_string())?;
    // clone the Arc so we do not hold the state lock while waiting on the audio thread
    let shared = {
        let slot = state.audio.lock();
        let b = slot.as_ref().ok_or("audio not started")?;
        b.shared.clone()
    };
    let (tx, rx) = std::sync::mpsc::channel();
    shared.requests.lock().push(audio::Request::Call { method, args, reply: tx });
    rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "engine call timed out".to_string())?
}

// ---------------------------------------------------------------- MIDI

#[tauri::command]
fn midi_outputs() -> Result<Vec<DeviceInfo>, String> {
    let out = midir::MidiOutput::new("gesture-synth").map_err(|e| e.to_string())?;
    Ok(out
        .ports()
        .iter()
        .enumerate()
        .map(|(i, p)| DeviceInfo { id: i.to_string(), name: out.port_name(p).unwrap_or_else(|_| format!("port {i}")) })
        .collect())
}

#[tauri::command]
fn midi_select(state: State<AppState>, id: String) -> Result<String, String> {
    let out = midir::MidiOutput::new("gesture-synth").map_err(|e| e.to_string())?;
    let ports = out.ports();
    let idx: usize = id.parse().map_err(|_| "bad port id")?;
    let port = ports.get(idx).ok_or("no such MIDI port")?;
    let name = out.port_name(port).unwrap_or_default();
    let conn = out.connect(port, "gesture-synth-out").map_err(|e| e.to_string())?;
    *state.midi.lock() = Some(conn);
    Ok(name)
}

#[tauri::command]
fn midi_close(state: State<AppState>) {
    if let Some(c) = state.midi.lock().take() {
        c.close();
    }
}

// ---------------------------------------------------------------- files

#[tauri::command]
fn list_files(app: AppHandle) -> Result<Vec<FileInfo>, String> {
    let dir = data_dir(&app)?;
    let mut out = Vec::new();
    for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let md = e.metadata().map_err(|e| e.to_string())?;
        if !md.is_file() {
            continue;
        }
        let modified = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        out.push(FileInfo { name: e.file_name().to_string_lossy().into_owned(), size: md.len(), modified });
    }
    Ok(out)
}

#[tauri::command]
fn read_file(app: AppHandle, name: String) -> Result<String, String> {
    fs::read_to_string(data_dir(&app)?.join(safe_name(&name)?)).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    fs::write(data_dir(&app)?.join(safe_name(&name)?), contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(app: AppHandle, name: String) -> Result<(), String> {
    fs::remove_file(data_dir(&app)?.join(safe_name(&name)?)).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_files(app: AppHandle) -> Result<(), String> {
    for f in list_files(app.clone())? {
        let _ = fs::remove_file(data_dir(&app)?.join(f.name));
    }
    Ok(())
}

#[tauri::command]
fn storage_usage(app: AppHandle) -> Result<serde_json::Value, String> {
    let used: u64 = list_files(app)?.iter().map(|f| f.size).sum();
    Ok(serde_json::json!({ "used": used }))
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| e.to_string())
}

/// Small persisted preferences the Rust side needs before the webview asks
/// (audio device + buffer size). Written by the frontend via `set_prefs`.
fn prefs_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|p| p.join("prefs.json")).unwrap_or_else(|_| PathBuf::from("prefs.json"))
}

fn read_prefs(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    fs::read_to_string(prefs_path(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
fn set_prefs(app: AppHandle, json: String) -> Result<(), String> {
    let p = prefs_path(&app);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(p, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- ffmpeg sidecar

#[tauri::command]
async fn ffmpeg_convert(app: AppHandle, input: Vec<u8>, input_ext: String, output_ext: String) -> Result<Vec<u8>, String> {
    let tmp = std::env::temp_dir().join(format!("gsyn-{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let in_path = tmp.join(format!("in.{}", safe_name(&input_ext)?));
    let out_path = tmp.join(format!("out.{}", safe_name(&output_ext)?));
    fs::write(&in_path, &input).map_err(|e| e.to_string())?;
    let mut args = vec!["-y".to_string(), "-i".into(), in_path.to_string_lossy().into_owned()];
    if output_ext == "mp4" {
        args.extend(["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"].iter().map(|s| s.to_string()));
    } else if output_ext == "webm" {
        args.extend(["-c:v", "libvpx-vp9", "-b:v", "4M", "-c:a", "libopus"].iter().map(|s| s.to_string()));
    }
    args.push(out_path.to_string_lossy().into_owned());
    // bundled sidecar first, then a system ffmpeg
    let output = match app.shell().sidecar("ffmpeg") {
        Ok(cmd) => cmd.args(&args).output().await,
        Err(_) => app.shell().command("ffmpeg").args(&args).output().await,
    }
    .map_err(|e| format!("ffmpeg failed to start: {e}"))?;
    if !output.status.success() {
        return Err(format!("ffmpeg exited with {:?}: {}", output.status.code(), String::from_utf8_lossy(&output.stderr).chars().rev().take(600).collect::<String>().chars().rev().collect::<String>()));
    }
    let bytes = fs::read(&out_path).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&tmp);
    Ok(bytes)
}

#[tauri::command]
fn app_version() -> String {
    format!("{} (core {})", env!("CARGO_PKG_VERSION"), gsyn_core::version())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState { audio: Mutex::new(None), midi: Arc::new(Mutex::new(None)) })
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // dev builds are not installed, so register the scheme at runtime
                let _ = app.deep_link().register_all();
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            native_audio_start,
            native_audio_stop,
            native_audio_devices,
            native_set_live,
            native_command,
            native_call,
            midi_outputs,
            midi_select,
            midi_close,
            list_files,
            read_file,
            write_file,
            delete_file,
            clear_files,
            storage_usage,
            open_data_folder,
            save_bytes,
            set_prefs,
            ffmpeg_convert,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gesture Synth");
}
