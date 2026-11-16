#!/usr/bin/env node
'use strict';
// Builds a Potree-style multi-resolution octree from a LAS point cloud, for the
// spatial viewer's level-of-detail point renderer.
//
//   node build_point_octree.js <in.las> <outDir>
//
// Output (in outDir):
//   hierarchy.json   bounds, per-node point counts / cube / child mask
//   r.bin, r0.bin, r01.bin ...   one file per node (name = "r" + octant digits)
//
// Every node holds a *sample* of the points that fall in its cube: the root a
// coarse sample of the whole cloud, its children progressively finer ones
// (one point kept per cell of a GRID^3 grid; the points that lose their cell
// are pushed down to the 8 child octants). The viewer therefore shows the
// union of the nodes it picked for the current view and can stay under a
// fixed point budget however large the cloud is.
//
// Node file layout (little endian):
//   float32 x,y,z * n   positions relative to the node cube's min corner
//   uint8   r,g,b * n   (only when hierarchy.hasColor)
//
// Pure Node (no npm modules): OpenProject always ships a Node binary.

const fs = require('fs');
const path = require('path');

const GRID = 32;                 // cells per axis -> at most 32768 points per node
const MAX_LEAF = GRID * GRID * GRID;
const MAX_DEPTH = 22;
const CHUNK_POINTS = 1 << 20;

const [, , inFile, outDir] = process.argv;
if (!inFile || !outDir) {
  console.error('usage: build_point_octree.js <in.las> <outDir>');
  process.exit(2);
}

function log(msg) { console.log('[octree] ' + msg); }

// ---- LAS header ------------------------------------------------------------
const fd = fs.openSync(inFile, 'r');
const hb = Buffer.alloc(375);
fs.readSync(fd, hb, 0, 375, 0);
if (hb.toString('latin1', 0, 4) !== 'LASF') throw new Error('not a LAS file');
const verMinor = hb[25];
const offsetToPoints = hb.readUInt32LE(96);
const pdrf = hb[104] & 0x7f;
const recLen = hb.readUInt16LE(105);
let count = hb.readUInt32LE(107);
if (verMinor >= 4 && count === 0) count = Number(hb.readBigUInt64LE(247));
const sx = hb.readDoubleLE(131), sy = hb.readDoubleLE(139), sz = hb.readDoubleLE(147);
const ox0 = hb.readDoubleLE(155), oy0 = hb.readDoubleLE(163), oz0 = hb.readDoubleLE(171);
if (!count || !recLen) throw new Error('LAS header reports no points');

const hasRGB = [2, 3, 5, 7, 8, 10].indexOf(pdrf) !== -1;
// RGB offset per point data record format (see the viewer's parseLAS)
const rgbOff = pdrf === 2 ? 20 : (pdrf === 3 || pdrf === 5) ? 28 : 30;
const intensityOff = 12;
log('points=' + count + ' pdrf=' + pdrf + ' recLen=' + recLen + ' rgb=' + hasRGB);

function forEachChunk(cb) {
  const buf = Buffer.alloc(CHUNK_POINTS * recLen);
  for (let start = 0; start < count; start += CHUNK_POINTS) {
    const n = Math.min(CHUNK_POINTS, count - start);
    const got = fs.readSync(fd, buf, 0, n * recLen, offsetToPoints + start * recLen);
    const m = Math.floor(got / recLen);
    cb(buf, start, m);
    if (m < n) break;
  }
}

// ---- pass A: exact integer bounds + colour range ----------------------------
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
let maxColor = 0, maxIntensity = 0;
let total = 0;
forEachChunk(function(buf, start, m) {
  for (let i = 0; i < m; i++) {
    const p = i * recLen;
    const x = buf.readInt32LE(p), y = buf.readInt32LE(p + 4), z = buf.readInt32LE(p + 8);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    if (hasRGB) {
      const r = buf.readUInt16LE(p + rgbOff), g = buf.readUInt16LE(p + rgbOff + 2), b = buf.readUInt16LE(p + rgbOff + 4);
      if (r > maxColor) maxColor = r; if (g > maxColor) maxColor = g; if (b > maxColor) maxColor = b;
    } else {
      const it = buf.readUInt16LE(p + intensityOff);
      if (it > maxIntensity) maxIntensity = it;
    }
  }
  total += m;
});
if (!total) throw new Error('no readable points');
const N = total;
const gmin = [minX * sx + ox0, minY * sy + oy0, minZ * sz + oz0];
const extent = [(maxX - minX) * sx, (maxY - minY) * sy, (maxZ - minZ) * sz];
const cubeSize = Math.max(extent[0], extent[1], extent[2], 1e-6) * (1 + 1e-6);
const colorMode = hasRGB ? 'rgb' : (maxIntensity > 0 ? 'intensity' : 'none');
const hasColor = colorMode !== 'none';
const colorDiv = maxColor > 255 ? 257 : 1;       // 16-bit -> 8-bit, or already 8-bit
log('bounds min=' + gmin.map(v => v.toFixed(3)) + ' extent=' + extent.map(v => v.toFixed(3)) + ' color=' + colorMode);

// ---- pass B: positions (float32, relative to the global min) + colours -------
const pos = new Float32Array(N * 3);
const col = hasColor ? new Uint8Array(N * 3) : null;
forEachChunk(function(buf, start, m) {
  for (let i = 0; i < m; i++) {
    const p = i * recLen, k = (start + i) * 3;
    pos[k] = (buf.readInt32LE(p) - minX) * sx;
    pos[k + 1] = (buf.readInt32LE(p + 4) - minY) * sy;
    pos[k + 2] = (buf.readInt32LE(p + 8) - minZ) * sz;
    if (colorMode === 'rgb') {
      col[k] = Math.round(buf.readUInt16LE(p + rgbOff) / colorDiv);
      col[k + 1] = Math.round(buf.readUInt16LE(p + rgbOff + 2) / colorDiv);
      col[k + 2] = Math.round(buf.readUInt16LE(p + rgbOff + 4) / colorDiv);
    } else if (colorMode === 'intensity') {
      const g = Math.round(buf.readUInt16LE(p + intensityOff) / maxIntensity * 255);
      col[k] = g; col[k + 1] = g; col[k + 2] = g;
    }
  }
});
fs.closeSync(fd);

// Outlier-trimmed bounds (0.5% .. 99.5% per axis, sampled): lets the viewer frame
// the camera on the real scan instead of on a few stray far-away points.
function percentileBounds() {
  const step = Math.max(1, Math.floor(N / 200000)), n = Math.ceil(N / step);
  const out = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let a = 0; a < 3; a++) {
    const s = new Float32Array(n);
    for (let i = 0, k = 0; i < N; i += step, k++) s[k] = pos[i * 3 + a];
    s.sort();
    out.min[a] = gmin[a] + s[Math.floor(0.005 * (n - 1))];
    out.max[a] = gmin[a] + s[Math.floor(0.995 * (n - 1))];
  }
  return out;
}
const robust = percentileBounds();

// ---- octree -----------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const cellStamp = new Int32Array(MAX_LEAF);
let stamp = 0;
const nodes = {};
let nodeCount = 0;

function writeNode(name, idx, n, ox, oy, oz) {
  const buf = Buffer.alloc(n * 12 + (hasColor ? n * 3 : 0));
  const f = new Float32Array(buf.buffer, buf.byteOffset, n * 3);
  for (let j = 0; j < n; j++) {
    const i = idx[j] * 3;
    f[j * 3] = pos[i] - ox; f[j * 3 + 1] = pos[i + 1] - oy; f[j * 3 + 2] = pos[i + 2] - oz;
    if (hasColor) {
      const c = n * 12 + j * 3;
      buf[c] = col[i]; buf[c + 1] = col[i + 1]; buf[c + 2] = col[i + 2];
    }
  }
  fs.writeFileSync(path.join(outDir, name + '.bin'), buf);
}

function build(name, idx, ox, oy, oz, size, depth) {
  nodeCount++;
  if (nodeCount % 500 === 0) log('nodes=' + nodeCount);

  if (idx.length <= MAX_LEAF || depth >= MAX_DEPTH) {
    writeNode(name, idx, idx.length, ox, oy, oz);
    nodes[name] = { n: idx.length, o: [ox, oy, oz], s: size, c: 0 };
    return;
  }

  // Keep one point per grid cell in this node; the rest go to the children.
  stamp++;
  const cell = size / GRID;
  const keep = new Uint32Array(MAX_LEAF);
  const rest = new Uint32Array(idx.length);
  let nk = 0, nr = 0;
  for (let j = 0; j < idx.length; j++) {
    const i = idx[j], k = i * 3;
    let cx = Math.floor((pos[k] - ox) / cell), cy = Math.floor((pos[k + 1] - oy) / cell), cz = Math.floor((pos[k + 2] - oz) / cell);
    if (cx < 0) cx = 0; else if (cx >= GRID) cx = GRID - 1;
    if (cy < 0) cy = 0; else if (cy >= GRID) cy = GRID - 1;
    if (cz < 0) cz = 0; else if (cz >= GRID) cz = GRID - 1;
    const key = (cx * GRID + cy) * GRID + cz;
    if (cellStamp[key] !== stamp) { cellStamp[key] = stamp; keep[nk++] = i; }
    else rest[nr++] = i;
  }
  writeNode(name, keep, nk, ox, oy, oz);

  // Split what is left into the 8 octants.
  const half = size / 2, mx = ox + half, my = oy + half, mz = oz + half;
  const counts = new Uint32Array(8);
  const oct = new Uint8Array(nr);
  for (let j = 0; j < nr; j++) {
    const k = rest[j] * 3;
    const o = (pos[k] >= mx ? 1 : 0) | (pos[k + 1] >= my ? 2 : 0) | (pos[k + 2] >= mz ? 4 : 0);
    oct[j] = o; counts[o]++;
  }
  const parts = new Array(8), fill = new Uint32Array(8);
  for (let o = 0; o < 8; o++) if (counts[o]) parts[o] = new Uint32Array(counts[o]);
  for (let j = 0; j < nr; j++) { const o = oct[j]; parts[o][fill[o]++] = rest[j]; }

  let mask = 0;
  for (let o = 0; o < 8; o++) if (counts[o]) mask |= (1 << o);
  nodes[name] = { n: nk, o: [ox, oy, oz], s: size, c: mask };

  for (let o = 0; o < 8; o++) {
    if (!counts[o]) continue;
    const part = parts[o];
    parts[o] = null;                       // let the child own (and free) it
    build(name + o, part,
      ox + ((o & 1) ? half : 0), oy + ((o & 2) ? half : 0), oz + ((o & 4) ? half : 0),
      half, depth + 1);
  }
}

const all = new Uint32Array(N);
for (let i = 0; i < N; i++) all[i] = i;
build('r', all, 0, 0, 0, cubeSize, 0);

fs.writeFileSync(path.join(outDir, 'hierarchy.json'), JSON.stringify({
  version: 1,
  count: N,
  origin: gmin,                 // absolute coordinates of the root cube's min corner
  size: cubeSize,
  grid: GRID,
  hasColor: hasColor,
  robust: robust,               // absolute, outlier-trimmed bounds for camera framing
  nodes: nodes
}));
log('done: ' + nodeCount + ' nodes for ' + N + ' points');
