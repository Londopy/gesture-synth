// Exports (spec 2 "Video export", 7 "File format", 9.5 "Share").
//  - .gsyn.json session, .mid, .wav come straight from the Rust core.
//  - webm clip: MediaRecorder on the scene canvas + the engine's record tap
//    (metronome cue bus excluded). No ffmpeg needed.
//  - mp4: desktop -> ffmpeg sidecar via Tauri command; web -> ffmpeg.wasm when
//    SharedArrayBuffer is available.

import { rt } from '../state/engine.svelte';
import { downloadFile, sanitize } from '../storage/store';
import { canExportMp4, isTauri } from '../platform';
import { ensureWasm } from '../tracking/parser';

export async function exportSession(name = rt.sessionName) {
  const json = await rt.sessionJson();
  await downloadFile(sanitize(name) + '.session.gsyn.json', json, 'application/json');
}

export async function exportMidi(name = rt.sessionName) {
  await ensureWasm();
  const { render_midi } = await import('../wasm/pkg/gsyn.js');
  const json = await rt.sessionJson();
  const bytes = render_midi(json);
  await downloadFile(sanitize(name) + '.mid', bytes, 'audio/midi');
}

export async function exportWav(name = rt.sessionName, passes = 2, sampleRate = 48000) {
  await ensureWasm();
  const { render_wav } = await import('../wasm/pkg/gsyn.js');
  const json = await rt.sessionJson();
  const bytes = render_wav(json, sampleRate, passes);
  await downloadFile(sanitize(name) + '.wav', bytes, 'audio/wav');
}

export interface ClipRecorder {
  stop(): Promise<Blob>;
  readonly mimeType: string;
}

/** Record the scene canvas + engine audio (no metronome) with MediaRecorder. */
export function startClip(canvas: HTMLCanvasElement, fps = 30): ClipRecorder {
  const videoStream = canvas.captureStream(fps);
  const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
  const tap = rt.worklet?.recordTap;
  if (tap) tracks.push(...tap.stream.getAudioTracks());
  const stream = new MediaStream(tracks);
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 6_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start(250);
  return {
    mimeType,
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
        rec.stop();
        stream.getTracks().forEach((t) => t.stop());
      }),
  };
}

/** 15 s share clip (spec 9.5). */
export async function recordShareClip(canvas: HTMLCanvasElement, seconds = 15, onProgress?: (p: number) => void): Promise<Blob> {
  const clip = startClip(canvas);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const p = Math.min(1, (performance.now() - t0) / (seconds * 1000));
      onProgress?.(p);
      if (p >= 1) resolve();
      else setTimeout(tick, 100);
    };
    tick();
  });
  return clip.stop();
}

/** Convert a webm blob to mp4 (H.264/AAC). */
export async function webmToMp4(webm: Blob, onLog?: (s: string) => void): Promise<Blob> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = new Uint8Array(await webm.arrayBuffer());
    const out = (await invoke('ffmpeg_convert', { input: Array.from(bytes), inputExt: 'webm', outputExt: 'mp4' })) as number[];
    return new Blob([new Uint8Array(out)], { type: 'video/mp4' });
  }
  if (!canExportMp4) throw new Error('mp4 export needs cross-origin isolation (SharedArrayBuffer); webm is available.');
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const { fetchFile, toBlobURL } = await import('@ffmpeg/util');
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => onLog?.(message));
  const base = 'https://unpkg.com/@ffmpeg/core-mt@0.12.10/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    workerURL: await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript'),
  });
  await ffmpeg.writeFile('in.webm', await fetchFile(webm));
  await ffmpeg.exec(['-i', 'in.webm', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'out.mp4']);
  const data = (await ffmpeg.readFile('out.mp4')) as Uint8Array;
  ffmpeg.terminate();
  return new Blob([new Uint8Array(data).buffer as ArrayBuffer], { type: 'video/mp4' });
}

export async function exportVideo(canvas: HTMLCanvasElement, seconds: number, format: 'webm' | 'mp4', name = rt.sessionName, onProgress?: (p: number, label: string) => void) {
  onProgress?.(0, 'Recording');
  const webm = await recordShareClip(canvas, seconds, (p) => onProgress?.(p * (format === 'mp4' ? 0.7 : 1), 'Recording'));
  if (format === 'webm') {
    await downloadFile(sanitize(name) + '.webm', webm, 'video/webm');
    onProgress?.(1, 'Done');
    return;
  }
  onProgress?.(0.75, 'Encoding mp4');
  const mp4 = await webmToMp4(webm);
  await downloadFile(sanitize(name) + '.mp4', mp4, 'video/mp4');
  onProgress?.(1, 'Done');
}
