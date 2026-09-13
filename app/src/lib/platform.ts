// Runtime feature flags (spec 3 "Web build differences", 9.5). The UI hides
// what the platform lacks rather than greying it out.

export const isTauri: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const hasSAB: boolean = typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated === true;

export const hasWebMIDI: boolean = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;

export const hasWebGPU: boolean = typeof navigator !== 'undefined' && 'gpu' in navigator;

export const hasOPFS: boolean =
  typeof navigator !== 'undefined' && !!navigator.storage && typeof (navigator.storage as any).getDirectory === 'function';

export const hasMediaRecorder: boolean = typeof MediaRecorder !== 'undefined';

export const isSafari: boolean =
  typeof navigator !== 'undefined' && /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|android/i.test(navigator.userAgent);

export const isMobile: boolean = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

export const isPhone: boolean = isMobile && typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 600;

export const isStandalonePWA: boolean =
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

/** Native ffmpeg is available through the Tauri sidecar only. */
export const hasNativeFfmpeg: boolean = isTauri;

/** ffmpeg.wasm needs SAB for mp4 (threads). webm always works via MediaRecorder. */
export const canExportMp4: boolean = isTauri || hasSAB;

export const flags = {
  isTauri,
  hasSAB,
  hasWebMIDI,
  hasWebGPU,
  hasOPFS,
  hasMediaRecorder,
  isSafari,
  isMobile,
  isPhone,
  isStandalonePWA,
  hasNativeFfmpeg,
  canExportMp4,
};

export function describePlatform(): string {
  const parts = [isTauri ? 'desktop' : 'web'];
  if (hasSAB) parts.push('SAB');
  if (hasWebMIDI) parts.push('MIDI');
  if (hasWebGPU) parts.push('WebGPU');
  if (isSafari) parts.push('Safari');
  if (isPhone) parts.push('phone');
  return parts.join(' · ');
}
