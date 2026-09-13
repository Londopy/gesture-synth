// Session / song / preset persistence. Web: OPFS with download/import as files.
// Desktop: the app data folder via Tauri commands. Same JSON either way.

import { hasOPFS, isTauri } from '../platform';

export type FileKind = 'session' | 'song' | 'instrument' | 'theme';

export interface StoredFile {
  name: string; // display name (without extension)
  kind: FileKind;
  size: number;
  modified: number;
}

const EXT: Record<FileKind, string> = {
  session: '.session.gsyn.json',
  song: '.song.gsyn.json',
  instrument: '.instrument.gsyn.json',
  theme: '.theme.gsyn.json',
};

export function fileName(name: string, kind: FileKind): string {
  return sanitize(name) + EXT[kind];
}

export function sanitize(name: string): string {
  return (name || 'untitled').replace(/[^a-z0-9 _.-]/gi, '_').slice(0, 80);
}

function kindOf(file: string): FileKind | null {
  for (const k of Object.keys(EXT) as FileKind[]) if (file.endsWith(EXT[k])) return k;
  return null;
}

interface Backend {
  list(kind?: FileKind): Promise<StoredFile[]>;
  read(name: string, kind: FileKind): Promise<string>;
  write(name: string, kind: FileKind, json: string): Promise<void>;
  remove(name: string, kind: FileKind): Promise<void>;
  usage(): Promise<{ used: number; quota: number }>;
  clear(): Promise<void>;
  location(): string;
}

class OpfsBackend implements Backend {
  private async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('gesture-synth', { create: true });
  }
  async list(kind?: FileKind): Promise<StoredFile[]> {
    const d = await this.dir();
    const out: StoredFile[] = [];
    for await (const [name, handle] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (handle.kind !== 'file') continue;
      const k = kindOf(name);
      if (!k || (kind && k !== kind)) continue;
      const f = await (handle as FileSystemFileHandle).getFile();
      out.push({ name: name.slice(0, -EXT[k].length), kind: k, size: f.size, modified: f.lastModified });
    }
    return out.sort((a, b) => b.modified - a.modified);
  }
  async read(name: string, kind: FileKind): Promise<string> {
    const d = await this.dir();
    const h = await d.getFileHandle(fileName(name, kind));
    return (await h.getFile()).text();
  }
  async write(name: string, kind: FileKind, json: string): Promise<void> {
    const d = await this.dir();
    const h = await d.getFileHandle(fileName(name, kind), { create: true });
    const w = await h.createWritable();
    await w.write(json);
    await w.close();
  }
  async remove(name: string, kind: FileKind): Promise<void> {
    const d = await this.dir();
    await d.removeEntry(fileName(name, kind));
  }
  async usage() {
    const e = await navigator.storage.estimate();
    return { used: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  async clear() {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('gesture-synth', { recursive: true });
  }
  location() {
    return 'Browser storage (OPFS)';
  }
}

/** localStorage fallback when OPFS is unavailable (old Safari, file://). */
class LocalBackend implements Backend {
  private key(name: string, kind: FileKind) {
    return 'gsyn.file.' + fileName(name, kind);
  }
  async list(kind?: FileKind): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (!k.startsWith('gsyn.file.')) continue;
      const file = k.slice('gsyn.file.'.length);
      const kk = kindOf(file);
      if (!kk || (kind && kk !== kind)) continue;
      const v = localStorage.getItem(k) ?? '';
      out.push({ name: file.slice(0, -EXT[kk].length), kind: kk, size: v.length, modified: 0 });
    }
    return out;
  }
  async read(name: string, kind: FileKind) {
    const v = localStorage.getItem(this.key(name, kind));
    if (v == null) throw new Error('not found');
    return v;
  }
  async write(name: string, kind: FileKind, json: string) {
    localStorage.setItem(this.key(name, kind), json);
  }
  async remove(name: string, kind: FileKind) {
    localStorage.removeItem(this.key(name, kind));
  }
  async usage() {
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) used += (localStorage.getItem(localStorage.key(i)!) ?? '').length;
    return { used, quota: 5_000_000 };
  }
  async clear() {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith('gsyn.file.')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  }
  location() {
    return 'Browser storage (localStorage)';
  }
}

class TauriBackend implements Backend {
  private inv = () => import('@tauri-apps/api/core').then((m) => m.invoke);
  async list(kind?: FileKind): Promise<StoredFile[]> {
    const invoke = await this.inv();
    const files = (await invoke('list_files')) as { name: string; size: number; modified: number }[];
    return files
      .map((f) => {
        const k = kindOf(f.name);
        return k ? { name: f.name.slice(0, -EXT[k].length), kind: k, size: f.size, modified: f.modified } : null;
      })
      .filter((f): f is StoredFile => !!f && (!kind || f.kind === kind))
      .sort((a, b) => b.modified - a.modified);
  }
  async read(name: string, kind: FileKind) {
    return (await (await this.inv())('read_file', { name: fileName(name, kind) })) as string;
  }
  async write(name: string, kind: FileKind, json: string) {
    await (await this.inv())('write_file', { name: fileName(name, kind), contents: json });
  }
  async remove(name: string, kind: FileKind) {
    await (await this.inv())('delete_file', { name: fileName(name, kind) });
  }
  async usage() {
    const r = (await (await this.inv())('storage_usage')) as { used: number };
    return { used: r.used, quota: 0 };
  }
  async clear() {
    await (await this.inv())('clear_files');
  }
  location() {
    return 'App data folder';
  }
}

export const store: Backend = isTauri ? new TauriBackend() : hasOPFS ? new OpfsBackend() : new LocalBackend();

/** Offer a file to the user as a download (web) or a save dialog (desktop). */
export async function downloadFile(name: string, data: string | Uint8Array | Blob, mime = 'application/octet-stream'): Promise<void> {
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: name });
    if (!path) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    await invoke('save_bytes', { path, bytes: Array.from(bytes) });
    return;
  }
  const blob = data instanceof Blob ? data : new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Ask the user for a file and return its text. */
export function pickFile(accept = '.json,application/json'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, text: await f.text() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
