// AudioWorkletGlobalScope has no TextDecoder/TextEncoder, but wasm-bindgen's
// generated glue constructs both at module load. This module is imported
// before the glue so the globals exist. UTF-8 only, good enough for JSON.

if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class TextDecoder {
    constructor(label, options) {
      this.encoding = 'utf-8';
      this.fatal = !!(options && options.fatal);
      this.ignoreBOM = !!(options && options.ignoreBOM);
    }
    decode(input) {
      if (input === undefined) return '';
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ? input.buffer : input);
      let out = '';
      let i = 0;
      const n = bytes.length;
      while (i < n) {
        const b0 = bytes[i++];
        if (b0 < 0x80) {
          out += String.fromCharCode(b0);
        } else if (b0 < 0xe0) {
          const b1 = bytes[i++] & 0x3f;
          out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
        } else if (b0 < 0xf0) {
          const b1 = bytes[i++] & 0x3f;
          const b2 = bytes[i++] & 0x3f;
          out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
        } else {
          const b1 = bytes[i++] & 0x3f;
          const b2 = bytes[i++] & 0x3f;
          const b3 = bytes[i++] & 0x3f;
          let cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    }
  };
}

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class TextEncoder {
    constructor() {
      this.encoding = 'utf-8';
    }
    encode(str) {
      str = String(str);
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        let cp = str.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
          const lo = str.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            i++;
          }
        }
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      }
      return new Uint8Array(bytes);
    }
    encodeInto(str, view) {
      const bytes = this.encode(str);
      const n = Math.min(bytes.length, view.length);
      view.set(bytes.subarray(0, n));
      return { read: n === bytes.length ? str.length : 0, written: n };
    }
  };
}
