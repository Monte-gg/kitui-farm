#!/usr/bin/env node
'use strict';

// Generates valid PNG app icons with no external dependencies.
// The previous hand-rolled encoder wrote a broken PNG signature and chunk
// layout, so browsers could not decode the icons, which made the app
// non-installable (no install prompt ever fired).
// Run from backend/: node bin/gen-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const ICONS = path.join(ROOT, 'icons');
const SIZES = [192, 512];
const SS = 4; // supersampling factor for smooth edges

const GREEN = [0x4a, 0x8c, 0x3f];
const WHITE = [0xff, 0xff, 0xff];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = ~0;
  for (let i = 0; i < buffer.length; i += 1) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function inEllipse(x, y, cx, cy, rx, ry, angle) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const u = dx * cos - dy * sin;
  const v = dx * sin + dy * cos;
  return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
}

function inCapsule(x, y, x1, y1, x2, y2, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return (x - px) * (x - px) + (y - py) * (y - py) <= radius * radius;
}

// A white sprout on a full-bleed green background: maskable-safe, since all
// artwork sits inside the central 80% safe zone.
function renderIcon(size) {
  const big = size * SS;
  const pixels = new Uint8Array(big * big * 4);

  for (let py = 0; py < big; py += 1) {
    for (let px = 0; px < big; px += 1) {
      const i = (py * big + px) * 4;
      pixels[i] = GREEN[0];
      pixels[i + 1] = GREEN[1];
      pixels[i + 2] = GREEN[2];
      pixels[i + 3] = 255;
    }
  }

  const paint = (test, colour) => {
    for (let py = 0; py < big; py += 1) {
      for (let px = 0; px < big; px += 1) {
        if (!test(px + 0.5, py + 0.5)) continue;
        const i = (py * big + px) * 4;
        pixels[i] = colour[0];
        pixels[i + 1] = colour[1];
        pixels[i + 2] = colour[2];
        pixels[i + 3] = 255;
      }
    }
  };

  const x = n => n * big;
  // stem
  paint((px, py) => inCapsule(px, py, x(0.5), x(0.72), x(0.5), x(0.40), x(0.045)), WHITE);
  // left leaf
  paint((px, py) => inEllipse(px, py, x(0.34), x(0.44), x(0.19), x(0.10), -0.55), WHITE);
  // right leaf
  paint((px, py) => inEllipse(px, py, x(0.67), x(0.36), x(0.20), x(0.105), 0.5), WHITE);

  // downsample with box filter
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let xx = 0; xx < size; xx += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = (((y * SS + sy) * big) + (xx * SS + sx)) * 4;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; a += pixels[i + 3];
        }
      }
      const count = SS * SS;
      const o = (y * size + xx) * 4;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
      out[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

fs.mkdirSync(ICONS, { recursive: true });
for (const size of SIZES) {
  const rgba = renderIcon(size);
  const buffer = encodePng(size, size, rgba);
  const target = path.join(ICONS, `icon-${size}x${size}.png`);
  fs.writeFileSync(target, buffer);
  console.log(`icon ${size}x${size} -> ${target} (${buffer.length} bytes)`);
}
console.log('icons regenerated');
