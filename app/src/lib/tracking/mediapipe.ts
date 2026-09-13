// Camera + MediaPipe Hand Landmarker (Tasks Vision, WASM/WebGL) in the webview.
// Emits per-frame hand landmark sets to a callback; the Rust parser does the rest.

import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';

export interface TrackedHand {
  landmarks: { x: number; y: number; z: number }[];
  /** Tracker label (before the parser's mirror correction). */
  left: boolean;
  confidence: number;
}

export interface TrackingFrame {
  hands: TrackedHand[];
  tMs: number;
  inferenceMs: number;
}

export type TrackingStatus = 'idle' | 'starting' | 'running' | 'error' | 'denied';

const RUNTIME_PATH = '/mediapipe';
const MODEL_PATH = '/models/hand_landmarker.task';
const MODEL_CDN = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

export class Tracking {
  video: HTMLVideoElement;
  stream: MediaStream | null = null;
  landmarker: HandLandmarker | null = null;
  status: TrackingStatus = 'idle';
  error = '';
  fps = 0;
  inferenceMs = 0;
  onFrame: ((f: TrackingFrame) => void) | null = null;
  onStatus: ((s: TrackingStatus, err?: string) => void) | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private frameTimes: number[] = [];
  private running = false;
  deviceId: string | undefined;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  private setStatus(s: TrackingStatus, err = '') {
    this.status = s;
    this.error = err;
    this.onStatus?.(s, err);
  }

  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    this.setStatus('starting');
    this.deviceId = deviceId;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, min: 24 },
          facingMode: deviceId ? undefined : 'user',
        },
        audio: false,
      });
    } catch (e: any) {
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      this.setStatus(denied ? 'denied' : 'error', e?.message ?? String(e));
      throw e;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.ensureLandmarker();
    this.running = true;
    this.setStatus('running');
    this.loop();
  }

  private async ensureLandmarker() {
    if (this.landmarker) return;
    const vision = await import('@mediapipe/tasks-vision');
    const fileset = await vision.FilesetResolver.forVisionTasks(RUNTIME_PATH);
    const modelPath = await this.resolveModel();
    const make = (delegate: 'GPU' | 'CPU') =>
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    try {
      this.landmarker = await make('GPU');
    } catch (e) {
      console.warn('[tracking] GPU delegate failed, falling back to CPU', e);
      this.landmarker = await make('CPU');
    }
  }

  private async resolveModel(): Promise<string> {
    // Prefer the locally served model (offline / PWA); fall back to the CDN.
    try {
      const r = await fetch(MODEL_PATH, { method: 'HEAD' });
      if (r.ok && Number(r.headers.get('content-length') ?? 1e9) > 100_000) return MODEL_PATH;
    } catch {
      /* ignore */
    }
    return MODEL_CDN;
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    let res: HandLandmarkerResult;
    try {
      res = this.landmarker.detectForVideo(v, now);
    } catch (e) {
      console.warn('[tracking] detect failed', e);
      return;
    }
    const inf = performance.now() - now;
    this.inferenceMs = this.inferenceMs * 0.9 + inf * 0.1;
    this.frameTimes.push(now);
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;
    const hands: TrackedHand[] = [];
    for (let i = 0; i < res.landmarks.length; i++) {
      const h = res.handedness[i]?.[0];
      hands.push({
        landmarks: res.landmarks[i],
        left: (h?.categoryName ?? 'Right') === 'Left',
        confidence: h?.score ?? 0.5,
      });
    }
    this.onFrame?.({ hands, tMs: now, inferenceMs: inf });
  };

  async switchCamera(deviceId: string) {
    this.stop(false);
    await this.start(deviceId);
  }

  stop(releaseModel = true) {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    if (releaseModel) {
      this.landmarker?.close();
      this.landmarker = null;
    }
    this.setStatus('idle');
  }
}
