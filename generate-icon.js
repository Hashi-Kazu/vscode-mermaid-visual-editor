#!/usr/bin/env node
'use strict';
// Generates media/icon.png — 128×128 mermaid tail icon
// Node.js built-ins only (zlib for PNG compression)

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const W = 128, H = 128;
const px = new Float32Array(W * H * 4); // RGBA [0..1]

// ─── Pixel helpers ────────────────────────────────────────────
function c01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function put(x, y, r, g, b, a) {
  x = x | 0; y = y | 0;
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) << 2;
  const fa = a, ba = px[i + 3];
  const oa = fa + ba - fa * ba;
  if (oa < 1e-5) return;
  px[i]     = (r * fa + px[i]     * ba * (1 - fa)) / oa;
  px[i + 1] = (g * fa + px[i + 1] * ba * (1 - fa)) / oa;
  px[i + 2] = (b * fa + px[i + 2] * ba * (1 - fa)) / oa;
  px[i + 3] = oa;
}

function disc(cx, cy, r, R, G, B, A) {
  for (let y = (cy - r - 1) | 0; y <= cy + r + 1; y++)
    for (let x = (cx - r - 1) | 0; x <= cx + r + 1; x++) {
      const aa = c01(r - Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) + 0.5);
      if (aa > 0) put(x, y, R, G, B, A * aa);
    }
}

function poly(pts, R, G, B, A) {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  for (let y = Math.floor(minY) - 1; y <= Math.ceil(maxY) + 1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y && by > y) || (by <= y && ay > y))
        xs.push(ax + (y - ay) / (by - ay) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let j = 0; j < xs.length - 1; j += 2) {
      const x0 = xs[j], x1 = xs[j + 1];
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const aa = c01(Math.min(x - x0 + 0.5, x1 - x + 0.5, 1));
        put(x, y, R, G, B, A * aa);
      }
    }
  }
}

function cubic(t, a, b, c, d) {
  const s = 1 - t;
  return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
}

// ─── Background ──────────────────────────────────────────────
const BG = [0.051, 0.106, 0.180]; // #0D1B2E
const CR = 22; // corner radius

for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const dx = x < CR ? CR - x : x >= W - CR ? x - (W - CR - 1) : 0;
    const dy = y < CR ? CR - y : y >= H - CR ? y - (H - CR - 1) : 0;
    const aa = c01(CR - Math.sqrt(dx * dx + dy * dy) + 0.5);
    if (aa > 0) put(x, y, BG[0], BG[1], BG[2], aa);
  }

// Subtle top-left radial highlight on bg
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const d = Math.sqrt((x - 18) ** 2 + (y - 12) ** 2);
    put(x, y, 0.14, 0.24, 0.40, c01(1 - d / 88) * 0.28);
  }

// ─── Colour palette ───────────────────────────────────────────
const T1 = [0.000, 0.773, 0.710]; // #00C5B5  main teal
const T2 = [0.000, 0.600, 0.553]; // #00998D  shadow teal
const T3 = [0.216, 0.922, 0.867]; // #37EBD9  highlight
const T4 = [0.000, 0.463, 0.427]; // #007669  dark scale

// ─── Spine (cubic bezier) ────────────────────────────────────
// P0=(64,13) control1=(77,40) control2=(51,70) P3=(64,90)
const N = 64;
const spX = [], spY = [];
for (let i = 0; i <= N; i++) {
  const t = i / N;
  spX.push(cubic(t, 64, 77, 51, 64));
  spY.push(cubic(t, 13, 40, 70, 90));
}

function tang(i) {
  const i0 = Math.max(0, i - 1), i1 = Math.min(N, i + 1);
  const dx = spX[i1] - spX[i0], dy = spY[i1] - spY[i0];
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  return [dx / l, dy / l];
}

function wPro(t) {
  // Wide at top, waist at t≈0.44, slight swell below
  return 17 + 3 * (1 - t) - 9 * Math.exp(-((t - 0.44) ** 2) / 0.025) + 2.5 * t;
}

const LP = [], RP = [];
for (let i = 0; i <= N; i++) {
  const t = i / N;
  const [tx, ty] = tang(i);
  const nx = -ty, ny = tx;
  const w = wPro(t);
  LP.push([spX[i] - nx * w, spY[i] - ny * w]);
  RP.push([spX[i] + nx * w, spY[i] + ny * w]);
}

// ─── Tail body ───────────────────────────────────────────────
poly([...LP, ...[...RP].reverse()], T1[0], T1[1], T1[2], 1);

// Highlight strip on left side
const cut = Math.floor(N * 0.52);
poly(
  [...LP.slice(0, cut), ...spX.slice(0, cut).map((x, i) => [x, spY[i]]).reverse()],
  T3[0], T3[1], T3[2], 0.48
);

// ─── Scales ──────────────────────────────────────────────────
for (let row = 0; row < 9; row++) {
  const t = 0.04 + row * 0.10;
  const si = Math.round(t * N);
  const cx = spX[si], cy = spY[si];
  const w  = wPro(t) * 0.78;
  const [tx, ty] = tang(si);
  const nx = -ty, ny = tx;
  const cols = row % 2 === 0 ? 3 : 4;
  for (let c = 0; c < cols; c++) {
    const u  = (c + 0.5) / cols - 0.5;
    const sx = cx + nx * u * w * 2.0 + tx * (row % 2 ? 2 : 0);
    const sy = cy + ny * u * w * 2.0 + ty * (row % 2 ? 2 : 0);
    if (Math.abs(u) * w * 2 > w - 1.5) continue;
    disc(sx, sy - 1, 4.8, T4[0], T4[1], T4[2], 0.55);
    disc(sx, sy - 1, 3.6, T1[0] + 0.04, T1[1], T1[2], 0.55);
  }
}

// ─── Tail fin ────────────────────────────────────────────────
// Left lobe: sweeps down-left
poly([
  [64, 88], [57, 91], [47, 96],
  [32, 108], [26, 118], [28, 122],
  [38, 116], [52, 105], [61, 97],
], T2[0], T2[1], T2[2], 1);
// Right lobe: sweeps down-right
poly([
  [64, 88], [71, 91], [81, 96],
  [96, 108], [102, 118], [100, 122],
  [90, 116], [76, 105], [67, 97],
], T2[0], T2[1], T2[2], 1);

// Fin highlights (leading edge)
poly([
  [64, 88], [57, 91], [47, 96], [32, 108], [26, 118],
  [33, 115], [50, 103], [63, 93],
], T3[0], T3[1], T3[2], 0.35);
poly([
  [64, 88], [71, 91], [81, 96], [96, 108], [102, 118],
  [95, 115], [78, 103], [65, 93],
], T3[0], T3[1], T3[2], 0.35);

// Notch between fin lobes (V-shape indent)
poly([
  [58, 95], [64, 106], [70, 95], [64, 91],
], BG[0], BG[1], BG[2], 1);

// ─── Top water-surface arc ───────────────────────────────────
for (let x = 20; x <= 108; x++) {
  const y = 12 + 1.8 * Math.sin((x - 64) * 0.11);
  for (let d = -1; d <= 1; d++)
    put(x, Math.round(y + d), T3[0], T3[1], T3[2], c01(0.55 - Math.abs(d) * 0.35));
}

// ─── Soft outer glow ─────────────────────────────────────────
// Two-pass: collect teal pixels, then spread
const glow = new Float32Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) << 2;
    if (px[i + 1] > 0.55 && px[i + 3] > 0.5) glow[y * W + x] = 1;
  }
for (let y = 2; y < H - 2; y++)
  for (let x = 2; x < W - 2; x++) {
    if (!glow[y * W + x]) {
      let s = 0;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d <= 3) s += glow[(y + dy) * W + (x + dx)] * (1 - d / 3.5);
        }
      if (s > 0) put(x, y, T1[0], T1[1], T1[2], c01(s * 0.045));
    }
  }

// ─── PNG encode ──────────────────────────────────────────────
const crcT = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcT[n] = c;
}
function crc32(b, s, l) {
  let c = -1;
  for (let i = s; i < s + l; i++) c = crcT[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, 4, 'ascii');
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b, 4, 4 + data.length), 8 + data.length);
  return b;
}

// RGB scanlines (composite against BG)
const scan = Buffer.alloc(H * (W * 3 + 1));
let p = 0;
for (let y = 0; y < H; y++) {
  scan[p++] = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) << 2;
    const a = px[i + 3];
    scan[p++] = Math.round(c01(px[i]     * a + BG[0] * (1 - a)) * 255);
    scan[p++] = Math.round(c01(px[i + 1] * a + BG[1] * (1 - a)) * 255);
    scan[p++] = Math.round(c01(px[i + 2] * a + BG[2] * (1 - a)) * 255);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

const out = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(scan, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dest = path.join(__dirname, 'media', 'icon.png');
fs.writeFileSync(dest, out);
console.log(`✓ icon.png (${out.length} bytes) → ${dest}`);
