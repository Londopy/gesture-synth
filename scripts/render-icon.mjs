// Rasterize app/public/icons/icon.svg to a 1024 px PNG (no native deps): a
// minimal software renderer for the shapes our icon uses, then `tauri icon`
// turns it into every platform format. Also writes the PWA icons.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const S = 1024;
const px = new Uint8Array(S * S * 4);

function put(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const ia = a / 255;
  px[i] = px[i] * (1 - ia) + r * ia;
  px[i + 1] = px[i + 1] * (1 - ia) + g * ia;
  px[i + 2] = px[i + 2] * (1 - ia) + b * ia;
  px[i + 3] = Math.min(255, px[i + 3] + a);
}
function roundedRect(rad, fill) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const cx = Math.max(rad, Math.min(S - rad, x));
      const cy = Math.max(rad, Math.min(S - rad, y));
      const d = Math.hypot(x - cx, y - cy);
      if (d <= rad) {
        const t = Math.hypot(x - S / 2, (y - S * 0.45)) / (S * 0.6);
        const k = Math.min(1, t);
        const [r, g, b] = fill(k);
        put(x, y, r, g, b, 255 * Math.min(1, rad - d + 1));
      }
    }
}
function line(x0, y0, x1, y1, w, col) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, col(t));
  }
}
function disc(cx, cy, r, [cr, cg, cb]) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r + 1) put(x, y, cr, cg, cb, 255 * Math.min(1, r - d + 1));
    }
}
function ring(cx, cy, r, w, col, alpha) {
  for (let y = Math.floor(cy - r - w); y <= cy + r + w; y++)
    for (let x = Math.floor(cx - r - w); x <= cx + r + w; x++) {
      const d = Math.abs(Math.hypot(x - cx, y - cy) - r);
      if (d <= w) put(x, y, ...col, alpha * Math.min(1, w - d + 1));
    }
}
const k = S / 128;
roundedRect(28 * k, (t) => [0x2a + (0x0b - 0x2a) * t, 0x2f + (0x0d - 0x2f) * t, 0x45 + (0x12 - 0x45) * t]);
ring(64 * k, 64 * k, 40 * k, 1 * k, [255, 255, 255], 46);
const grad = (t) => [0xff + (0x7b - 0xff) * t, 0xb3 + (0x8c - 0xb3) * t, 0x47 + (0xff - 0x47) * t];
const bones = [[46, 92, 46, 62], [46, 62, 38, 40], [46, 62, 50, 30], [46, 62, 60, 36], [46, 62, 66, 48], [46, 92, 64, 100], [64, 100, 82, 92], [82, 92, 82, 64], [82, 64, 78, 34], [82, 64, 92, 40]];
for (const [x0, y0, x1, y1] of bones) line(x0 * k, y0 * k, x1 * k, y1 * k, 4 * k, (t) => grad((x0 + (x1 - x0) * t) / 128));
for (const [x, y] of [[38, 40], [50, 30], [60, 36], [66, 48], [78, 34], [92, 40]]) disc(x * k, y * k, 3.5 * k, [255, 255, 255]);

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let table;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
function resize(src, size) {
  const out = new Uint8Array(size * size * 4);
  const f = S / size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * f); yy < Math.floor((y + 1) * f); yy++)
        for (let xx = Math.floor(x * f); xx < Math.floor((x + 1) * f); xx++) {
          const i = (yy * S + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      const o = (y * size + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  return out;
}
mkdirSync('src-tauri/icons', { recursive: true });
writeFileSync('src-tauri/icons/app-icon.png', png(S, S, px));
writeFileSync('app/public/icons/icon-512.png', png(512, 512, resize(px, 512)));
writeFileSync('app/public/icons/icon-192.png', png(192, 192, resize(px, 192)));
console.log('wrote src-tauri/icons/app-icon.png (1024) and PWA icons');
