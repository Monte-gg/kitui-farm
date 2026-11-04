#!/usr/bin/env node
'use strict';

// Regenerate backend/public/icons/icon-*.png from the SVG source. The source
// of truth for the icon lives in the repo-root icons/ folder (served at
// /icons/...), so this script writes there. Run from backend/ with:
//   node bin/gen-icons.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const ICONS = path.join(ROOT, 'icons');
const SVG = path.join(ICONS, 'icon.svg');
const SIZES = [192, 512];

fs.mkdirSync(ICONS, { recursive: true });
if (!fs.existsSync(SVG)) {
  console.error('icons: icon.svg missing at', SVG);
  process.exit(1);
}
const svg = fs.readFileSync(SVG, 'utf8');
function sizedSvg(size) {
  return svg
    .replace(/<svg[^>]*>/, m => m
      .replace(/(width\s*=\s*"[^"]*"|height\s*=\s*"[^"]*")/g, '')
      .replace('<svg', '<svg width="' + size + '" height="' + size + '"'));
}

const createCanvas = (() => { try { return require('canvas').createCanvas; } catch (e) { return null; } })();

if (createCanvas) {
  (async () => {
    for (const size of SIZES) {
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f5f7f2';
      ctx.fillRect(0, 0, size, size);
      const img = new (require('canvas').Image)();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = no;
        img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(sizedSvg(size));
      });
      ctx.drawImage(img, 0, 0, size, size);
      fs.writeFileSync(path.join(ICONS, 'icon-' + size + 'x' + size + '.png'), canvas.toBuffer('image/png'));
      console.log('icon', size, 'png via canvas');
    }
    console.log('icons regenerated at', ICONS);
  })();
} else {
  for (const size of SIZES) {
    const px = size;
    const data = new Uint8Array(px * px * 4);
    const fill = (x, y, r, g, b, a) => {
      if (a == null) a = 255;
      const i = (y * px + x) * 4;
      if (i >= 0 && i < data.length) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; }
    };
    const cx = px / 2, cy = px / 2, R = px / 2 - 1;
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= R * R) fill(x, y, 74, 140, 63, 255);
    }
    const bagX = px * 0.5, bagY = px * 0.62, bw = px * 0.34, bh = px * 0.22;
    for (let y = 0; y <= bh * 2 + 1; y++) for (let x = 0; x <= bw * 2 + 1; x++) {
      const nx = bagX - bw + x, ny = bagY - bh + y;
      if (nx < 0 || ny < 0 || nx >= px || ny >= px) continue;
      const tx = (x - bw) / bw, ty = (y - bh) / bh;
      if (Math.abs(tx) < 1 - Math.abs(ty) * 0.35 && ty > -1 && ty < 1) fill(nx, ny, 255, 255, 255, 235);
    }
    const dots = [
      [bagX - bw * 0.6, bagY - bh * 1.15, px * 0.055, [74,140,63]],
      [bagX - bw * 0.3, bagY - bh * 1.25, px * 0.055, [58,122,42]],
      [bagX,            bagY - bh * 1.2,  px * 0.055, [74,140,63]],
      [bagX + bw * 0.3, bagY - bh * 1.15, px * 0.055, [58,122,42]],
      [bagX + bw * 0.6, bagY - bh * 1.05, px * 0.055, [74,140,63]]
    ];
    const circ = (x, y, r, c) => {
      for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r * r) {
          const X = Math.round(x + dx), Y = Math.round(y + dy);
          if (X >= 0 && X < px && Y >= 0 && Y < px) fill(X, Y, c[0], c[1], c[2], 255);
        }
      }
    };
    for (const [dx, dy, r, c] of dots) circ(dx, dy, r, c);
    for (let x = bagX - bw; x <= bagX + bw; x++) {
      const y = bagY - bh;
      if (x >= 0 && x < px && y >= 0 && y < px) fill(x, y, 45, 90, 39, 255);
    }
    function makeChunk(type, dataBuf) {
      const len = dataBuf.length;
      const buf = Buffer.alloc(4 + type.length + 4 + dataBuf.length + 4);
      buf.writeUInt32BE(len, 0);
      buf.write(type, 4, type.length);
      dataBuf.copy(buf, 4 + type.length);
      let crc = 0xffffffff;
      const update = (v) => {
        let i = 0;
        while (i < v.length) {
          crc ^= v.charCodeAt(i) & 0xff;
          for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
          i++;
        }
      };
      update(type);
      update(dataBuf.toString('binary'));
      crc = (crc ^ 0xffffffff) >>> 0;
      buf.writeUInt32BE(crc, 4 + type.length + dataBuf.length);
      return buf;
    }
    const raw = Buffer.alloc(px * (1 + px * 4));
    let off = 0;
    for (let y = 0; y < px; y++) {
      raw[off++] = 0;
      for (let x = 0; x < px; x++) {
        const i = (y * px + x) * 4;
        raw[off++] = data[i]; raw[off++] = data[i + 1]; raw[off++] = data[i + 2]; raw[off++] = data[i + 3];
      }
    }
    const zlib = require('node:zlib');
    const ihdr = Buffer.alloc(13);
    ihdr.write('IHDR', 0); ihdr.writeUInt32BE(px, 4); ihdr.writeUInt32BE(px, 8); ihdr.writeUInt8(8, 12); ihdr.writeUInt8(6, 13);
    const out = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      makeChunk('IHDR', ihdr),
      makeChunk('IDAT', zlib.deflateSync(raw)),
      makeChunk('IEND', Buffer.alloc(0))
    ]);
    fs.writeFileSync(path.join(ICONS, 'icon-' + size + 'x' + size + '.png'), out);
    console.log('icon', size, 'png (built-in)');
  }
  console.log('icons regenerated at', ICONS);
}
