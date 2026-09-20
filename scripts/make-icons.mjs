/* Generates the home-screen icons: a rounded tile with a paw on it.
   Written by hand so the build has no image dependencies — raw RGBA
   scanlines through zlib is all a PNG really is. */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const BG = [15, 122, 90];       // --accent
const FG = [255, 255, 255];

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return buf => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* Signed-distance-ish coverage so edges come out smooth rather than jagged. */
const cover = (d, soft = 1.2) => Math.max(0, Math.min(1, 0.5 - d / soft));

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 100;                     // work in a 100x100 design space
  const radius = 22 * s;

  // Paw: three toes across the top, one pad below. x, y, rx, ry in design space.
  const toes = [
    [31, 41, 9.5, 12],
    [50, 34, 10, 13],
    [69, 41, 9.5, 12]
  ];
  const pad = [50, 68, 18, 15];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5, cy = y + 0.5;

      // rounded square
      const dx = Math.max(radius - cx, cx - (size - radius), 0);
      const dy = Math.max(radius - cy, cy - (size - radius), 0);
      const tile = cover(Math.hypot(dx, dy) - radius);
      if (tile <= 0) { px[i + 3] = 0; continue; }

      let paw = 0;
      for (const [ex, ey, erx, ery] of [...toes, pad]) {
        const nx = (cx - ex * s) / (erx * s);
        const ny = (cy - ey * s) / (ery * s);
        // approximate pixel distance to the ellipse edge
        const r = Math.hypot(nx, ny);
        paw = Math.max(paw, cover((r - 1) * erx * s));
      }

      const c = paw > 0
        ? [BG[0] + (FG[0] - BG[0]) * paw, BG[1] + (FG[1] - BG[1]) * paw, BG[2] + (FG[2] - BG[2]) * paw]
        : BG;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
      px[i + 3] = Math.round(tile * 255);
    }
  }
  return png(size, size, px);
}

const out = path.resolve('public');
for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), draw(size));
  console.log(`icon-${size}.png`);
}
