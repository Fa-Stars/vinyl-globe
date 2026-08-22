'use strict';
/* ================= 世界唱片机 前端逻辑（歌曲版） ================= */

const audio = document.getElementById('audio');
const deck = document.getElementById('deck');
const record = document.getElementById('record');
const label = document.getElementById('label');
const labelTitle = document.getElementById('label-title');
const labelArtist = document.getElementById('label-artist');

const el = (id) => document.getElementById(id);
const npStation = el('np-station');
const npCountry = el('np-country');
const npMeta = el('np-meta');
const npStatus = el('np-status');
const npProgressFill = el('np-progress-fill');
const globeCountry = el('globe-country');
const globeHint = el('globe-hint');
const globeLat = el('globe-lat');
const globeLon = el('globe-lon');
const ledText = el('led-text');
const btnPlay = el('btn-play');

const globe = document.getElementById('globe');
const gctx = globe.getContext('2d');

/* ---------------- 状态 ---------------- */
let map = { w: 144, h: 72, grid: '', names: {}, aliases: {} };
let current = null;       // 当前歌曲
let nextSong = null;      // 预取的下一首
let fetching = null;      // 预取 Promise
let started = false;      // 用户是否已交互（浏览器自动播放策略）
let skipCount = 0;
let watchdog = null;
let autoTimer = null;     // 试听结束自动切换的定时器
let highlightCode = null; // 当前高亮国家（像素地球仪）
let flashUntil = 0;       // 切歌信号闪烁结束时间
let rot = 0;              // 地球仪旋转（经度，度）
let targetRot = null;     // 要转到的国家经度（null = 空闲自转）

/* ---------------- 工具 ---------------- */
function codeToFlag(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  return Array.from(code).map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function setStatus(text) { npStatus.textContent = text; }

function fmtDuration(sec) {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtCoordinate(value, positive, negative) {
  if (!Number.isFinite(value)) return '--°';
  return Math.abs(value).toFixed(1) + '°' + (value >= 0 ? positive : negative);
}

/* ---------------- 音频控制 ---------------- */
function togglePlay() {
  if (!current) { next(); return; }
  if (audio.paused) {
    audio.play().catch(() => setStatus('需要点击页面后播放'));
  } else {
    audio.pause();
  }
}

function setPlayingUI(on) {
  deck.classList.toggle('playing', on);
  ledText.textContent = on ? 'ON AIR' : 'STANDBY';
  btnPlay.textContent = on ? '⏸' : '▶';
}

function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (!started) return;
    if (audio.readyState >= 3) return; // 已能播放
    autoSkip('连接超时，正在跳过…');
  }, 10000);
}

function autoSkip(reason) {
  setStatus(reason);
  skipCount++;
  if (skipCount >= 8) {
    setStatus('连续失败，请稍后重试（或再按 R）');
    return;
  }
  setTimeout(next, 400);
}

audio.addEventListener('playing', () => {
  setPlayingUI(true);
  skipCount = 0;
  clearTimeout(watchdog);
  clearTimeout(autoTimer);
  if (current) setStatus('播放中 · ' + current.title);
});
audio.addEventListener('waiting', () => setStatus('缓冲中…'));
audio.addEventListener('stalled', () => setStatus('缓冲中…'));
audio.addEventListener('pause', () => { if (!audio.ended) setPlayingUI(false); });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration;
  if (d && isFinite(d) && d > 0) {
    npProgressFill.style.width = Math.min(100, (audio.currentTime / d) * 100) + '%';
  }
});
audio.addEventListener('ended', () => {
  if (!started || !current) return;
  setPlayingUI(false);
  setStatus('歌曲结束，自动播放下一首…');
  clearTimeout(autoTimer);
  autoTimer = setTimeout(next, 700);
});
audio.addEventListener('error', () => {
  if (started && current) autoSkip('音频加载失败，正在换一首…');
});

/* ---------------- 歌曲切换 ---------------- */
async function fetchSong() {
  const r = await fetch('/api/song');
  if (!r.ok) throw new Error('api ' + r.status);
  return r.json();
}

function prefetch() {
  fetching = fetchSong()
    .then((s) => { nextSong = s; })
    .catch(() => { nextSong = null; });
}

// 歌曲开始后，异步解析艺术家国籍并点亮地球仪（未解析到时轮询）
let countryPollTimer = null;
function pollCountry(id) {
  clearTimeout(countryPollTimer);
  (async () => {
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch('/api/country?id=' + encodeURIComponent(id));
        if (!r.ok) break;
        const j = await r.json();
        if (j.countrycode) { applyCountry(j); return; }
        if (j.status === 'none' || j.status === 'error') return;
      } catch (e) { /* 网络错误：稍后重试 */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
  })();
}

function applyCountry(j) {
  setCountry(j.countrycode, j.country);
  if (current) {
    current.countrycode = j.countrycode || '';
    current.country = j.country || '未知地区';
  }
}

// 统一设置"当前国家"：更新高亮、让地球仪转过去并缩放、刷新显示
function setCountry(code, displayName) {
  code = /^[A-Z]{2}$/.test(code) ? code : null;
  if (code && map.aliases[code]) code = map.aliases[code];
  if (code !== highlightCode) flashUntil = performance.now() + 140;
  highlightCode = code; // 保留（即使该国家在地图上没有格子）
  // 定位与缩放：
  //  - 有领土格子 → 转到国家质心（国家居中），按领土大小缩放
  //  - 无格子（微型国）→ 用首都坐标定位（首都居中），默认 4x 看周边
  if (code) {
    if (countryLon[code] !== undefined) {
      targetRot = countryLon[code];
      targetPitch = countryLat[code] || 0;
      targetZoom = countryZoom(code);
    } else if (capitals[code]) {
      targetRot = capitals[code][1];
      targetPitch = capitals[code][0];
      targetZoom = 4;
    } else {
      targetRot = null; targetPitch = 0; targetZoom = 1;
    }
  } else {
    targetRot = null; targetPitch = 0; targetZoom = 1;
  }
  // 显示
  const name = displayName || (code && map.names[code]) || '未知地区';
  const flag = codeToFlag(code);
  npCountry.textContent = flag + ' ' + name;
  globeCountry.textContent = flag + ' ' + name;
  const cap = code && capitals[code];
  const lat = cap ? cap[0] : (code ? countryLat[code] : undefined);
  const lon = cap ? cap[1] : (code ? countryLon[code] : undefined);
  globeLat.textContent = fmtCoordinate(lat, 'N', 'S');
  globeLon.textContent = fmtCoordinate(lon, 'E', 'W');
  globeHint.textContent = code ? 'SIGNAL LOCKED · 已锁定' : 'WAITING FOR SIGNAL · 等待定位';
  return code;
}

function setSong(s) {
  current = s;
  setCountry(s.countrycode, s.country);

  npStation.textContent = s.title;
  npMeta.textContent = [s.artist, s.album, fmtDuration(s.duration)].filter(Boolean).join(' · ');
  npProgressFill.style.width = '0%';

  // 未带国家信息 → 后台解析（MusicBrainz/Bing），完成后地球仪亮起并转过去
  if (!s.countrycode && s.id) pollCountry(s.id);

  // 唱片标签：优先用专辑封面，否则用主题色渐变
  if (s.artwork) {
    label.style.background =
      'url("' + s.artwork + '") center / cover no-repeat, #111';
  } else {
    const hue = hashHue(s.title + s.artist);
    label.style.background =
      'radial-gradient(circle at 32% 30%, hsl(' + hue + ', 72%, 62%), hsl(' + hue + ', 70%, 42%) 70%)';
  }
  labelTitle.textContent = s.title;
  labelArtist.textContent = s.artist;

  setStatus('连接中…');
  audio.src = s.streamUrl;
  audio.load();
  armWatchdog();
  if (started) {
    audio.play().catch(() => { /* 静默，等用户交互 */ });
  }
}

async function next() {
  skipCount = 0;
  clearTimeout(autoTimer);
  setStatus('正在切换…');
  let s = nextSong;
  nextSong = null;
  if (!s) {
    try {
      s = await fetchSong();
    } catch (e) {
      setStatus('获取歌曲失败，请重试');
      return;
    }
  }
  setSong(s);
  prefetch();
}

/* ================================================================
   像素地球（夜航控制台）
   - 纯球体：等距柱状地图 → 正交投影，带球体明暗（无支架底座）
   - 任意方向旋转：偏航(rot) + 俯仰(pitch)，可转到任意国家正前方
   - 自适应缩放：按国家领土大小放大，小国也占画面足够比例
   - 行为：有国家时转到该国正面并闪烁高亮；空闲时缓慢自转
   ================================================================ */
const GW = 320, GH = 320;          // 逻辑画布尺寸（高分辨率，CSS 放大 + pixelated）
const GCX = 160, GCY = 160;        // 球心
const GR = 136;                    // 球半径（缩放前）
const ZOOM_MIN = 1, ZOOM_MAX = 7;  // 缩放范围（国家居中，同时能看到周边邻国）
const ZOOM_FILL = 0.28;            // 目标：国家约占画面高度 28%，保留地缘格局

// 夜航控制台配色：深海蓝 + 低饱和陆地 + 琥珀定位信号
const PAL = {
  skyBands: [[4, 12, 23], [5, 20, 34], [7, 31, 45], [10, 43, 52], [13, 55, 57]],
  rim: [53, 148, 140],
  star: [170, 224, 196],
  seaDeep: [3, 26, 45],
  seaMid: [5, 55, 73],
  seaLit: [17, 101, 105],
  outline: [9, 33, 42],
  landDark: [25, 64, 59],
  land: [53, 119, 96],
  landLit: [122, 185, 139],
  hiA: [255, 196, 80],
  hiB: [255, 240, 174],
  flagRed: [255, 108, 92],
  pole: [226, 244, 211],
  poleDark: [79, 111, 104],
  markerGlow: [255, 206, 106],
};

let backdrop = null;   // 静态背景（梦幻天空+柔光+星空）
let frameImg = null;   // 复用的帧缓冲（避免每帧分配内存）
let landBorder = null; // Uint8Array 陆地描边
let countryLon = {};   // code -> 质心经度（度）
let countryLat = {};   // code -> 质心纬度（度）
let countryArea = {};  // code -> 领土格子数（用于缩放）
let capitals = {};     // code -> [纬度, 经度]（首都坐标，用于标记）
let pitch = 0;         // 当前俯仰角（度）
let zoom = 1;          // 当前缩放
let targetPitch = 0;
let targetZoom = 1;

function setPx(d, x, y, rgb) {
  if (x < 0 || x >= GW || y < 0 || y >= GH) return;
  const i = (y * GW + x) * 4;
  d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
}

// 预计算：陆地描边 + 各国质心
function buildGlobeData() {
  const W = map.w, H = map.h, grid = map.grid;
  landBorder = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid.substr((y * W + x) * 2, 2);
      if (c === '..' || c === '') continue;
      const nb = [
        grid.substr((y * W + ((x + 1) % W)) * 2, 2),
        grid.substr((y * W + ((x + W - 1) % W)) * 2, 2),
        grid.substr((((y + 1) % H) * W + x) * 2, 2),
        grid.substr((((y + H - 1) % H) * W + x) * 2, 2),
      ];
      if (nb.some((cc) => cc === '..' || cc === '')) landBorder[y * W + x] = 1;
    }
  }
  const acc = {};
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = grid.substr((y * W + x) * 2, 2);
      if (c === '..' || c === '') continue;
      const lon = -180 + (x + 0.5) * (360 / W);
      const lat = 90 - (y + 0.5) * (180 / H);
      if (!acc[c]) acc[c] = { sx: 0, sy: 0, slat: 0, n: 0 };
      const a = acc[c];
      a.sx += Math.sin((lon * Math.PI) / 180);
      a.sy += Math.cos((lon * Math.PI) / 180);
      a.slat += lat;
      a.n++;
    }
  }
  for (const [c, a] of Object.entries(acc)) {
    countryLon[c] = ((Math.atan2(a.sx, a.sy) * 180) / Math.PI + 360) % 360;
    countryLat[c] = a.slat / a.n;
    countryArea[c] = a.n; // 领土格子数 → 决定缩放级别
  }
}

// 按国家领土大小计算缩放级别（小国放大，大国小放）
function countryZoom(code) {
  const area = countryArea[code] || 1;
  const spanDeg = 2.5 * Math.sqrt(area); // 近似角直径（度）
  const z = (180 * ZOOM_FILL) / spanDeg; // 让国家约占画面 45% 高度
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function blendPx(d, x, y, rgb, alpha) {
  if (x < 0 || x >= GW || y < 0 || y >= GH) return;
  const i = (y * GW + x) * 4;
  d[i] = Math.round(d[i] + (rgb[0] - d[i]) * alpha);
  d[i + 1] = Math.round(d[i + 1] + (rgb[1] - d[i + 1]) * alpha);
  d[i + 2] = Math.round(d[i + 2] + (rgb[2] - d[i + 2]) * alpha);
}

function drawPixelCircle(d, cx, cy, radius, rgb, alpha) {
  const steps = Math.max(24, Math.round(radius * 4));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    blendPx(d, Math.round(cx + Math.cos(a) * radius), Math.round(cy + Math.sin(a) * radius), rgb, alpha);
  }
}

// 静态背景：深空色带 + 球体边缘细描边 + 低亮度星点
function buildBackdrop() {
  backdrop = gctx.createImageData(GW, GH);
  const d = backdrop.data;
  // 天空：分段色带保留像素感，但降低饱和度以衬托定位信号
  const bands = PAL.skyBands;
  const bandH = GH / bands.length;
  for (let y = 0; y < GH; y++) {
    const b = Math.min(bands.length - 1, Math.floor(y / bandH));
    const c = bands[b];
    for (let x = 0; x < GW; x++) {
      const i = (y * GW + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  // 球体边缘：青绿色细线，替代旧版突兀的纯蓝边框
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const dist = Math.hypot(x - GCX, y - GCY);
      if (dist > GR + 3 && dist < GR + 6) blendPx(d, x, y, PAL.rim, .16);
      if (dist > GR && dist <= GR + 3) {
        const i = (y * GW + x) * 4;
        d[i] = PAL.rim[0]; d[i + 1] = PAL.rim[1]; d[i + 2] = PAL.rim[2]; d[i + 3] = 255;
      }
    }
  }
  // 星点：确定性分布，避免每帧闪烁
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 86; i++) {
    const x = (rnd() * GW) | 0;
    const y = (rnd() * GH) | 0;
    if (Math.hypot(x - GCX, y - GCY) < GR + 8) continue;
    setPx(d, x, y, PAL.star);
  }
}

// 某国当前在屏幕上的位置（用于定位标记）
function countryScreenPos(latDeg, lonDeg) {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  const r = (rot * Math.PI) / 180, p = (pitch * Math.PI) / 180;
  // 世界方向 → 摄像机方向（先逆偏航，再逆俯仰）
  const dy2 = -Math.sin(la);
  const dx = Math.cos(la) * Math.sin(lo - r);
  const dz2 = Math.cos(la) * Math.cos(lo - r);
  const dy = dy2 * Math.cos(p) + dz2 * Math.sin(p);
  const dz = -dy2 * Math.sin(p) + dz2 * Math.cos(p);
  const Rz = GR * zoom;
  return { x: GCX + dx * Rz, y: GCY + dy * Rz, visible: dz > 0.05 };
}

function drawGlobe(now) {
  if (!frameImg) frameImg = gctx.createImageData(GW, GH);
  const d = frameImg.data;
  if (backdrop) d.set(backdrop.data);
  if (!map.grid || !landBorder) {
    gctx.putImageData(frameImg, 0, 0);
    return;
  }

  const pulse = 0.5 + 0.5 * Math.sin(now / 150);
  const hiCol = pulse > 0.5 ? PAL.hiA : PAL.hiB;
  const W = map.w, H = map.h, grid = map.grid;
  const Rz = GR * zoom;
  const pRad = (pitch * Math.PI) / 180;
  const cosp = Math.cos(pRad), sinp = Math.sin(pRad);

  // 球体渲染（正交投影 + 任意方向旋转 + 缩放）
  const yMin = Math.max(0, Math.floor(GCY - Rz) - 1);
  const yMax = Math.min(GH - 1, Math.ceil(GCY + Rz) + 1);
  const xMin = Math.max(0, Math.floor(GCX - Rz) - 1);
  const xMax = Math.min(GW - 1, Math.ceil(GCX + Rz) + 1);
  for (let py = yMin; py <= yMax; py++) {
    for (let px = xMin; px <= xMax; px++) {
      const dx = (px - GCX) / Rz;
      const dy = (py - GCY) / Rz;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const dz = Math.sqrt(1 - d2);
      // 俯仰旋转
      const dy2 = dy * cosp - dz * sinp;
      const dz2 = dy * sinp + dz * cosp;
      const lat = (Math.asin(-dy2) * 180) / Math.PI;
      const lon = (((Math.atan2(dx, dz2) * 180) / Math.PI + rot + 540) % 360) - 180;
      const gx = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
      const gy = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
      const code = grid.substr((gy * W + gx) * 2, 2);

      let rgb;
      if (code === '..' || code === '') {
        rgb = dz > 0.92 ? PAL.seaLit : dz > 0.6 ? PAL.seaMid : PAL.seaDeep;
      } else {
        if (highlightCode && code === highlightCode) rgb = hiCol;
        else if (landBorder[gy * W + gx]) rgb = PAL.outline; // 纯黑描边
        else rgb = dz > 0.92 ? PAL.landLit : dz > 0.6 ? PAL.land : PAL.landDark;
      }
      // 像素色块感：主体保持纯色，仅最外圈做一次暗角
      const sh = dz > 0.22 ? 1 : 0.55;
      setPx(d, px, py, [
        Math.min(255, (rgb[0] * sh) | 0),
        Math.min(255, (rgb[1] * sh) | 0),
        Math.min(255, (rgb[2] * sh) | 0),
      ]);
    }
  }

  // 首都标记：琥珀色像素定位环 + 小旗标，位置随球面旋转/缩放移动
  if (highlightCode) {
    const cap = capitals[highlightCode];
    const lat0 = cap ? cap[0] : countryLat[highlightCode];
    const lon0 = cap ? cap[1] : countryLon[highlightCode];
    if (lat0 !== undefined && lon0 !== undefined) {
      const pos = countryScreenPos(lat0, lon0);
      if (pos.visible) {
        const mx = Math.round(pos.x);
        const my = Math.round(pos.y);
        const M = Math.max(1, Math.round(GR / 58)); // 标记随分辨率缩放
        const bounce = Math.round(Math.sin(now / 200) * M);
        const flagCol = pulse > 0.5 ? PAL.flagRed : PAL.hiB; // 旗帜红白闪烁
        const markerRadius = Math.max(5, Math.round(M * 5 + pulse * 2));
        drawPixelCircle(d, mx, my + bounce, markerRadius, PAL.markerGlow, .68);
        // 底座
        for (let x = mx - M; x <= mx + M; x++) setPx(d, x, my + bounce, PAL.poleDark);
        // 旗杆
        for (let y = my - 1; y >= my - 4 * M; y--) setPx(d, mx, y + bounce, PAL.pole);
        // 旗帜（向右展开）
        for (let y = my - 4 * M; y <= my - 2 * M - 1; y++) {
          for (let x = mx + 1; x <= mx + 2 * M; x++) setPx(d, x, y + bounce, flagCol);
        }
      }
    }
  }

  // 切歌信号闪烁：短暂提亮，不再整屏爆白
  if (flashUntil > now) {
    const f = 0.18 * ((flashUntil - now) / 140);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, Math.round(d[i] + (255 - d[i]) * f));
      d[i + 1] = Math.min(255, Math.round(d[i + 1] + (255 - d[i + 1]) * f));
      d[i + 2] = Math.min(255, Math.round(d[i + 2] + (255 - d[i + 2]) * f));
    }
  }
  gctx.putImageData(frameImg, 0, 0);
}

function updateGlobe() {
  if (targetRot !== null) {
    // 偏航（最短弧） + 俯仰 + 缩放 平滑趋近
    const delta = ((targetRot - rot + 540) % 360) - 180;
    if (Math.abs(delta) < 0.4) rot = targetRot;
    else rot += delta * 0.08;             // 转向更干脆（红白机手感）
    pitch += (targetPitch - pitch) * 0.06;
    zoom += (targetZoom - zoom) * 0.06;
  } else {
    rot = (rot + 0.06 + 360) % 360;       // 空闲缓慢自转
    pitch += (0 - pitch) * 0.03;          // 回正
    zoom += (1 - zoom) * 0.03;            // 还原
  }
}

function globeLoop(t) {
  updateGlobe();
  drawGlobe(t);
  requestAnimationFrame(globeLoop);
}

/* ---------------- 交互 ---------------- */
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'r') {
    e.preventDefault();
    started = true;
    next();
  } else if (k === ' ') {
    e.preventDefault();
    started = true;
    togglePlay();
  }
});

btnPlay.addEventListener('click', () => { started = true; togglePlay(); });
el('btn-next').addEventListener('click', () => { started = true; next(); });
record.addEventListener('click', () => { started = true; togglePlay(); });

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    const r = await fetch('map.json');
    if (r.ok) map = await r.json();
  } catch (e) {
    console.warn('map.json 加载失败', e);
  }
  try {
    const r2 = await fetch('capitals.json');
    if (r2.ok) capitals = await r2.json();
  } catch (e) {
    console.warn('capitals.json 加载失败', e);
  }
  buildGlobeData();
  globe.width = GW;
  globe.height = GH;
  buildBackdrop();
  requestAnimationFrame(globeLoop);

  prefetch(); // 预取第一首
  setStatus('按 R 随机播放世界歌曲，或点击唱片');

  // ?demo=1 ：打开页面即自动加载并播放（用于测试/演示）
  if (new URLSearchParams(location.search).has('demo')) {
    started = true;
    next();
  }
})();
