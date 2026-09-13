// Video recorder: scene canvas or the raw camera picture, the engine mix (no
// metronome) and an optional microphone, into webm via MediaRecorder with
// start/stop control. mp4 conversion reuses webmToMp4 from video.ts.

import { rt } from '../state/engine.svelte';
import { downloadFile, sanitize } from '../storage/store';
import { webmToMp4 } from './video';

export interface RecorderOptions {
  source: 'scene' | 'camera';
  canvas: HTMLCanvasElement | null;
  fps: number;
  mic: boolean;
  micDeviceId: string;
  micGain: number;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export class VideoRecorder {
  state: RecorderState = 'idle';
  startedAt = 0;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserCtx: AudioContext | null = null;
  private levelBuf = new Uint8Array(256);
  mimeType = '';
  /** Which audio sources made it into the file, for the UI. */
  audioSources: string[] = [];

  static async listMics(): Promise<MediaDeviceInfo[]> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput');
    } catch {
      return [];
    }
  }

  async start(opts: RecorderOptions): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'starting';
    try {
      const tracks: MediaStreamTrack[] = [];
      // video
      if (opts.source === 'camera') {
        const cam = rt.tracking?.stream;
        if (!cam) throw new Error('The camera is not running');
        tracks.push(...cam.getVideoTracks());
      } else {
        if (!opts.canvas) throw new Error('No scene canvas');
        tracks.push(...opts.canvas.captureStream(opts.fps).getVideoTracks());
      }
      // mic
      if (opts.mic) {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
          video: false,
        });
      }
      // audio: engine mix + mic through the worklet context when available
      this.audioSources = [];
      if (rt.worklet) {
        const mix = rt.worklet.recordMix(this.micStream, opts.micGain);
        tracks.push(...mix.getAudioTracks());
        this.audioSources.push('instrument');
        if (this.micStream) this.audioSources.push('mic');
      } else if (this.micStream) {
        // native desktop audio: the engine mix cannot be tapped from the webview; mic only
        tracks.push(...this.micStream.getAudioTracks());
        this.audioSources.push('mic');
      }
      // level meter on whatever audio we have
      const audioTracks = tracks.filter((t) => t.kind === 'audio');
      if (audioTracks.length) {
        this.analyserCtx = rt.worklet?.ctx ?? new AudioContext();
        const src = this.analyserCtx.createMediaStreamSource(new MediaStream(audioTracks));
        this.analyser = this.analyserCtx.createAnalyser();
        this.analyser.fftSize = 512;
        src.connect(this.analyser);
      }
      this.stream = new MediaStream(tracks);
      const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
      this.mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      this.rec = new MediaRecorder(this.stream, { mimeType: this.mimeType || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      this.chunks = [];
      this.rec.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      this.rec.start(500);
      this.startedAt = performance.now();
      this.state = 'recording';
    } catch (e) {
      this.cleanup();
      this.state = 'idle';
      throw e;
    }
  }

  /** 0..1 input level for the meter. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuf);
    let peak = 0;
    for (let i = 0; i < this.levelBuf.length; i++) peak = Math.max(peak, Math.abs(this.levelBuf[i] - 128));
    return peak / 128;
  }

  setMicGain(v: number) {
    rt.worklet?.setMicGain(v);
  }

  get elapsedMs(): number {
    return this.state === 'recording' ? performance.now() - this.startedAt : 0;
  }

  async stop(): Promise<Blob> {
    if (!this.rec || this.state !== 'recording') throw new Error('not recording');
    this.state = 'stopping';
    const rec = this.rec;
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: this.mimeType || 'video/webm' }));
      rec.stop();
    });
    this.cleanup();
    this.state = 'idle';
    return blob;
  }

  private cleanup() {
    this.rec = null;
    rt.worklet?.stopRecordMix();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    // canvas capture tracks must be stopped, camera tracks belong to the tracker
    this.stream?.getVideoTracks().forEach((t) => {
      if (!rt.tracking?.stream?.getVideoTracks().includes(t)) t.stop();
    });
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    if (this.analyserCtx && this.analyserCtx !== rt.worklet?.ctx) void this.analyserCtx.close();
    this.analyserCtx = null;
  }
}

export async function saveRecording(blob: Blob, format: 'webm' | 'mp4', name: string, onLog?: (s: string) => void): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'mp4') {
    const mp4 = await webmToMp4(blob, onLog);
    await downloadFile(`${sanitize(name)}-${stamp}.mp4`, mp4, 'video/mp4');
  } else {
    await downloadFile(`${sanitize(name)}-${stamp}.webm`, blob, blob.type || 'video/webm');
  }
}
