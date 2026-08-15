'use strict';
// 临时工具：渲染像素地球 PNG 供目视检查（与 app.js 逻辑一致，无第三方依赖）
const fs = require('fs');
const zlib = require('zlib');

const map = JSON.parse(fs.readFileSync('public/map.json', 'utf8'));

const GW = 320, GH = 320, GCX = 160, GCY = 160, GR = 132;
const ZOOM_MAX = 7, ZOOM_FILL = 0.32;
const PAL = {
  skyTop: [24, 28, 60], skyBot: [52, 54, 100], glow: [140, 170, 210], star: [255, 244, 214],
  seaDeep: [70, 136, 178], seaMid: [104, 168, 202], seaLit: [152, 204, 228],
  landDark: [84, 128, 58], land: [126, 178, 76], landLit: [170, 210, 108],
  hiA: [255, 224, 122], hiB: [255, 247, 214],
  flagRed: [232, 125, 111], pole: [210, 216, 228], poleDark: [118, 126, 146],
};
const capitals = JSON.parse(fs.readFileSync('public/capitals.json', 'utf8'));
const buf = Buffer.alloc(GW * GH * 4);
const setPx = (x, y, rgb) => {
  if (x < 0 || x >= GW || y < 0 || y >= GH) return;
  const i = (y * GW + x) * 4;
  buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
};
// 梦幻渐变天空 + 柔光 + 星空
(function buildBackdrop() {
  for (let y = 0; y < GH; y++) {
    const t = y / (GH - 1);
    const r = Math.round(PAL.skyTop[0] + (PAL.skyBot[0] - PAL.skyTop[0]) * t);
    const g = Math.round(PAL.skyTop[1] + (PAL.skyBot[1] - PAL.skyTop[1]) * t);
    const b = Math.round(PAL.skyTop[2] + (PAL.skyBot[2] - PAL.skyTop[2]) * t);
    for (let x = 0; x < GW; x++) {
      const i = (y * GW + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const dist = Math.hypot(x - GCX, y - GCY);
    if (dist > GR && dist < GR + 20) {
      const f = 1 - (dist - GR) / 20;
      const a = 0.3 * f;
      const i = (y * GW + x) * 4;
      buf[i] = Math.min(255, Math.round(buf[i] + PAL.glow[0] * a));
      buf[i + 1] = Math.min(255, Math.round(buf[i + 1] + PAL.glow[1] * a));
      buf[i + 2] = Math.min(255, Math.round(buf[i + 2] + PAL.glow[2] * a));
    }
  }
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 90; i++) {
    const x = (rnd() * GW) | 0;
    const y = (rnd() * GH) | 0;
    if (Math.hypot(x - GCX, y - GCY) < GR + 12) continue;
    const tw = 0.5 + 0.5 * rnd();
    setPx(x, y, [Math.round(PAL.star[0] * tw), Math.round(PAL.star[1] * tw), Math.round(PAL.star[2] * tw)]);
  }
})();

// 国家质心 / 面积
const acc = {};
for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
  const c = map.grid.substr((y * map.w + x) * 2, 2);
  if (c === '..') continue;
  const lon = -180 + (x + 0.5) * (360 / map.w);
  const lat = 90 - (y + 0.5) * (180 / map.h);
  if (!acc[c]) acc[c] = { sx: 0, sy: 0, slat: 0, n: 0 };
  acc[c].sx += Math.sin(lon * Math.PI / 180); acc[c].sy += Math.cos(lon * Math.PI / 180); acc[c].slat += lat; acc[c].n++;
}
const countryLon = {}, countryLat = {}, countryArea = {};
for (const [c, a] of Object.entries(acc)) {
  countryLon[c] = ((Math.atan2(a.sx, a.sy) * 180 / Math.PI) + 360) % 360;
  countryLat[c] = a.slat / a.n;
  countryArea[c] = a.n;
}
function countryZoom(code) {
  const area = countryArea[code] || 1;
  const spanDeg = 2.5 * Math.sqrt(area);
  return Math.min(ZOOM_MAX, Math.max(1, (180 * ZOOM_FILL) / spanDeg));
}

// 陆地描边
const landBorder = new Uint8Array(map.w * map.h);
for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
  const c = map.grid.substr((y * map.w + x) * 2, 2);
  if (c === '..') continue;
  const nb = [map.grid.substr((y * map.w + ((x + 1) % map.w)) * 2, 2), map.grid.substr((y * map.w + ((x + map.w - 1) % map.w)) * 2, 2),
              map.grid.substr((((y + 1) % map.h) * map.w + x) * 2, 2), map.grid.substr((((y + map.h - 1) % map.h) * map.w + x) * 2, 2)];
  if (nb.some((cc) => cc === '..')) landBorder[y * map.w + x] = 1;
}

// 渲染指定国家（转到正面 + 按大小缩放；无格子国家用首都兜底）
function render(code, zoomOverride) {
  const hasCells = countryLon[code] !== undefined;
  const cap = capitals[code];
  let rot, pitch, zoom;
  if (hasCells) {
    rot = countryLon[code];
    pitch = countryLat[code];
    zoom = zoomOverride || countryZoom(code);
  } else if (cap) {
    rot = cap[1];
    pitch = cap[0];
    zoom = zoomOverride || 4;
  } else {
    return null;
  }
  const pulse = 0.8;
  const hiCol = pulse > 0.5 ? PAL.hiA : PAL.hiB;
  const Rz = GR * zoom;
  const pRad = pitch * Math.PI / 180;
  const cosp = Math.cos(pRad), sinp = Math.sin(pRad);
  const yMin = Math.max(0, Math.floor(GCY - Rz) - 1);
  const yMax = Math.min(GH - 1, Math.ceil(GCY + Rz) + 1);
  const xMin = Math.max(0, Math.floor(GCX - Rz) - 1);
  const xMax = Math.min(GW - 1, Math.ceil(GCX + Rz) + 1);
  for (let py = yMin; py <= yMax; py++) {
    for (let px = xMin; px <= xMax; px++) {
      const dx = (px - GCX) / Rz, dy = (py - GCY) / Rz;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const dz = Math.sqrt(1 - d2);
      const dy2 = dy * cosp - dz * sinp;
      const dz2 = dy * sinp + dz * cosp;
      const lat = Math.asin(-dy2) * 180 / Math.PI;
      const lon = (((Math.atan2(dx, dz2) * 180 / Math.PI) + rot + 540) % 360) - 180;
      const gx = Math.min(map.w - 1, Math.max(0, Math.floor((lon + 180) / 360 * map.w)));
      const gy = Math.min(map.h - 1, Math.max(0, Math.floor((90 - lat) / (180 / map.h))));
      const c = map.grid.substr((gy * map.w + gx) * 2, 2);
      let r, g, b;
      if (c === '..') {
        const s = dz > 0.92 ? PAL.seaLit : dz > 0.6 ? PAL.seaMid : PAL.seaDeep;
        r = s[0]; g = s[1]; b = s[2];
      } else {
        let base;
        if (c === code) base = hiCol;
        else base = landBorder[gy * map.w + gx] ? PAL.landDark : (dz > 0.92 ? PAL.landLit : PAL.land);
        r = base[0]; g = base[1]; b = base[2];
      }
      const sh = 0.6 + 0.4 * dz;
      setPx(px, py, [(r * sh) | 0, (g * sh) | 0, (b * sh) | 0]);
    }
  }
  // 首都像素旗标记（与 app.js 一致，随分辨率缩放）
  const capM = capitals[code];
  const la0 = capM ? capM[0] : countryLat[code];
  const lo0 = capM ? capM[1] : countryLon[code];
  const laR = la0 * Math.PI / 180, loR = lo0 * Math.PI / 180;
  const rR = rot * Math.PI / 180, pR = pitch * Math.PI / 180;
  const dy2 = -Math.sin(laR);
  const dxS = Math.cos(laR) * Math.sin(loR - rR);
  const dz2 = Math.cos(laR) * Math.cos(loR - rR);
  const dyS = dy2 * Math.cos(pR) + dz2 * Math.sin(pR);
  const dzS = -dy2 * Math.sin(pR) + dz2 * Math.cos(pR);
  const mx = Math.round(GCX + dxS * Rz);
  const my = Math.round(GCY + dyS * Rz);
  const M = Math.max(1, Math.round(GR / 58));
  const flagCol = pulse > 0.5 ? PAL.flagRed : PAL.hiB;
  for (let x = mx - M; x <= mx + M; x++) setPx(x, my, PAL.poleDark);
  for (let y = my - 1; y >= my - 4 * M; y--) setPx(mx, y, PAL.pole);
  for (let y = my - 4 * M; y <= my - 2 * M - 1; y++) for (let x = mx + 1; x <= mx + 2 * M; x++) setPx(x, y, flagCol);
  return { rot, pitch, zoom, area: countryArea[code], marker: [mx, my] };
}

// ---- PNG 编码 ----
function crc32(b) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < b.length; i++) crc = table[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function savePng(file, scale) {
  const W = GW * scale, H = GH * scale;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const sy = (y / scale) | 0;
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const sx = (x / scale) | 0;
      const i = (sy * GW + sx) * 4;
      const o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = buf[i]; raw[o + 1] = buf[i + 1]; raw[o + 2] = buf[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
function ascii() {
  const cls = (i) => {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    // 按主色相分类（容忍明暗缩放）
    if (r > 180 && g > 160 && b < 160) return '*'; // 高亮黄
    if (r > 200 && g > 200 && b > 200) return '#'; // 高亮白/标记
    if (b > r && b > g) return b < 60 && r < 60 ? ' ' : '.'; // 海/天
    if (g > r && g > b) return 'L';                        // 陆地
    return '?';
  };
  let out = '';
  for (let y = 0; y < GH; y += 2) {
    let line = '';
    for (let x = 0; x < GW; x += 2) line += cls((y * GW + x) * 4);
    out += line + '\n';
  }
  return out;
}

(async () => {
  for (const code of ['DE', 'US', 'RU', 'NL', 'MT', 'SG', 'JP', 'BR']) {
    const info = render(code);
    if (!info) { console.log(code + ': 无法定位'); continue; }
    const file = 'data/globe-' + code + '.png';
    savePng(file, 3);
    let flagPx = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] === PAL.flagRed[0] && buf[i + 1] === PAL.flagRed[1] && buf[i + 2] === PAL.flagRed[2]) flagPx++;
    }
    const cells = countryArea[code] ? countryArea[code] + '格' : '无格子(首都兜底)';
    console.log(code + ': ' + cells + ', 缩放=' + info.zoom.toFixed(2) + 'x, 旗标记@(' + info.marker[0] + ',' + info.marker[1] + '), 旗像素=' + flagPx);
  }
  // 德国全景 + 特写
  render('DE', 1);
  console.log('\n--- 德国全景 (zoom=1, pitch=52°) ---');
  console.log(ascii());
  render('DE');
  console.log('\n--- 德国特写 (zoom=7) ---');
  console.log(ascii());
  // 荷兰（无格子 → 首都阿姆斯特丹兜底）
  render('NL');
  console.log('\n--- 荷兰特写 (无格子, 首都兜底 zoom=4) ---');
  console.log(ascii());
})();
