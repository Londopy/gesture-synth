// Web MIDI output (browser + Tauri webview where supported). The Rust engine
// produces the bytes; this just picks a port and sends.

import { hasWebMIDI } from '../platform';

export class MidiOut {
  access: MIDIAccess | null = null;
  port: MIDIOutput | null = null;
  outputs: { id: string; name: string }[] = [];
  enabled = false;
  error = '';
  onChange: (() => void) | null = null;

  get available(): boolean {
    return hasWebMIDI;
  }

  async init(): Promise<boolean> {
    if (!hasWebMIDI) return false;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.refresh();
      this.access.onstatechange = () => {
        this.refresh();
        this.onChange?.();
      };
      return true;
    } catch (e: any) {
      this.error = e?.message ?? String(e);
      return false;
    }
  }

  private refresh() {
    this.outputs = [];
    if (!this.access) return;
    this.access.outputs.forEach((o) => this.outputs.push({ id: o.id, name: o.name ?? o.id }));
    if (this.port && !this.access.outputs.get(this.port.id)) this.port = null;
  }

  select(id: string) {
    this.port = this.access?.outputs.get(id) ?? null;
  }

  send(bytes: Uint8Array) {
    if (!this.enabled || !this.port) return;
    for (let i = 0; i + 2 < bytes.length + 1; i += 3) {
      const m = bytes.subarray(i, i + 3);
      if (m.length === 3) {
        try {
          this.port.send(m);
        } catch {
          /* port gone */
        }
      }
    }
  }

  allNotesOff() {
    if (!this.port) return;
    for (let ch = 0; ch < 16; ch++) this.port.send([0xb0 | ch, 123, 0]);
  }
}

export const midiOut = new MidiOut();
