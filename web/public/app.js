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
const npProgress = el('np-progress');
const npProgressFill = el('np-progress-fill');
const npCurrentTime = el('np-current-time');
const npDuration = el('np-duration');
const npMode = el('np-mode');
const npIndex = el('np-index');
const globeCountry = el('globe-country');
const globeHint = el('globe-hint');
const globeLat = el('globe-lat');
const globeLon = el('globe-lon');
const globeStage = document.querySelector('.globe-stage');
const globeSignalCopy = el('globe-signal-copy');
const globePin = el('globe-pin');
const globePinCountry = el('globe-pin-country');
const ledText = el('led-text');
const btnPlay = el('btn-play');
const btnNext = el('btn-next');
const deckBadge = el('deck-badge');
const deckTipCopy = el('deck-tip-copy');
const headerStatusText = el('header-status-text');
const sourceLink = el('source-link');
const settingsButton = el('settings-button');
const settingsModal = el('settings-modal');
const settingsClose = el('settings-close');
const settingsCancel = el('settings-cancel');
const settingsSave = el('settings-save');
const settingsToggleKey = el('settings-toggle-key');
const settingsClientId = el('jamendo-client-id');
const settingsStatus = el('settings-status');

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
let rot = 0;              // 地球仪旋转（经度，度）
let targetRot = null;     // 要转到的国家经度（null = 空闲自转）
let trackNumber = 0;
let nextRequest = 0;
let sourceMode = 'itunes';
let settingsReturnFocus = null;

// 地图呈现归属：保留原始网格编码，但在界面上作为同一显示区域处理。
const DISPLAY_CODE_ALIASES = { TW: 'CN' };
const DISPLAY_NAMES = { CN: '中国' };

// Web 版用页面会话通知后端：最后一个页面关闭后，后端才能安全退出并清理缓存。
// Electron 页面不注册会话，由 Electron 主进程统一处理窗口关闭。
function createBrowserSessionId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch (e) { /* 使用降级 ID */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

const browserSessionId = window.electronAPI ? '' : createBrowserSessionId();
let browserHeartbeat = null;

function browserSessionUrl(state) {
  return '/api/client-session?id=' + encodeURIComponent(browserSessionId) + '&state=' + state;
}

function sendBrowserSession(state, beacon) {
  if (!browserSessionId) return;
  const url = browserSessionUrl(state);
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(url);
    return;
  }
  fetch(url, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
}

function startBrowserSession() {
  if (!browserSessionId) return;
  sendBrowserSession('connect', false);
  browserHeartbeat = setInterval(() => sendBrowserSession('heartbeat', false), 15000);
  window.addEventListener('pagehide', (event) => {
    // bfcache 恢复时页面仍然活着，不能误报为窗口关闭。
    if (event.persisted) return;
    clearInterval(browserHeartbeat);
    sendBrowserSession('disconnect', true);
  }, { once: true });
}

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

function setDeckBadge(text, state) {
  deckBadge.textContent = text;
  if (state) deckBadge.dataset.state = state;
  else delete deckBadge.dataset.state;
}

function updateSourceLabels(mode) {
  sourceMode = mode === 'jamendo' ? 'jamendo' : 'itunes';
  const isFullTrack = sourceMode === 'jamendo';
  headerStatusText.textContent = isFullTrack ? 'FULL TRACKS · JAMENDO' : '30 SEC PREVIEWS · ITUNES';
  npMode.textContent = isFullTrack ? 'FULL TRACK' : '30 SEC PREVIEW';
  sourceLink.textContent = isFullTrack ? 'Jamendo' : 'iTunes';
  sourceLink.href = isFullTrack ? 'https://www.jamendo.com' : 'https://www.apple.com/itunes/';
  settingsButton.innerHTML = '<span aria-hidden="true">⚙</span> ' + (window.electronAPI ? 'Jamendo 设置' : '播放模式');
}

function setSettingsStatus(text, isError) {
  settingsStatus.textContent = text || '';
  settingsStatus.style.color = isError ? '#ff8d7b' : '';
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsSave.disabled = false;
  settingsCancel.disabled = false;
  settingsToggleKey.disabled = false;
  if (settingsReturnFocus && typeof settingsReturnFocus.focus === 'function') {
    settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
}

async function openSettings() {
  settingsReturnFocus = document.activeElement;
  settingsModal.hidden = false;
  setSettingsStatus('');
  settingsClientId.disabled = false;
  settingsSave.disabled = false;
  settingsCancel.disabled = false;
  settingsToggleKey.disabled = false;
  if (!window.electronAPI) {
    settingsClientId.disabled = true;
    settingsSave.disabled = true;
    settingsToggleKey.disabled = true;
    setSettingsStatus('浏览器版沿用当前服务模式；如需切换，请使用桌面版设置。', true);
    settingsClose.focus();
    return;
  }
  try {
    const settings = await window.electronAPI.getSettings();
    settingsClientId.value = settings.jamendoClientId || '';
    setSettingsStatus(settings.mode === 'jamendo' ? '当前模式：Jamendo 全曲' : '当前模式：iTunes 30 秒试听');
    settingsClientId.focus();
  } catch (error) {
    setSettingsStatus('读取设置失败，请重试。', true);
  }
}

async function saveSettings() {
  if (!window.electronAPI) return;
  settingsSave.disabled = true;
  settingsCancel.disabled = true;
  settingsToggleKey.disabled = true;
  setSettingsStatus('正在保存并重启本地服务，请稍候…');
  try {
    const result = await window.electronAPI.saveJamendoClientId(settingsClientId.value);
    if (!result || !result.ok) {
      setSettingsStatus((result && result.error) || '保存失败，请重试。', true);
      settingsSave.disabled = false;
      settingsCancel.disabled = false;
      settingsToggleKey.disabled = false;
      return;
    }
    setSettingsStatus(result.mode === 'jamendo' ? '已切换到 Jamendo 全曲模式，正在刷新…' : '已切换到 iTunes 试听模式，正在刷新…');
    setTimeout(() => window.location.reload(), 350);
  } catch (error) {
    setSettingsStatus('保存失败，请重试。', true);
    settingsSave.disabled = false;
    settingsCancel.disabled = false;
    settingsToggleKey.disabled = false;
  }
}

function fmtDuration(sec) {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtCoordinate(value, positive, negative) {
  if (!Number.isFinite(value)) return '--°';
  return Math.abs(value).toFixed(1) + '°' + (value >= 0 ? positive : negative);
}

function displayCodeFor(code) {
  return DISPLAY_CODE_ALIASES[code] || code;
}

function isHighlightedMapCode(code) {
  return code === highlightCode ||
    (highlightCode === 'CN' && code === 'TW');
}

/* ---------------- 音频控制 ---------------- */
function togglePlay() {
  if (!current) { next(); return; }
  if (audio.paused) {
    started = true;
    armWatchdog();
    setStatus('正在启动音频…');
    audio.play().catch(() => setStatus('播放失败，请检查网络后重试'));
  } else {
    audio.pause();
  }
}

function setPlayingUI(on) {
  deck.classList.toggle('playing', on);
  ledText.textContent = on ? 'ON AIR' : 'STANDBY';
  btnPlay.textContent = on ? '⏸' : '▶';
  btnPlay.setAttribute('aria-label', on ? '暂停' : '播放');
  btnPlay.setAttribute('aria-pressed', String(on));
  if (on) {
    setDeckBadge('ON AIR', 'live');
    deckTipCopy.textContent = '正在播放 · 点击唱片暂停';
  } else if (current) {
    setDeckBadge('READY TO PLAY');
    deckTipCopy.textContent = '点击唱片或按空格继续播放';
  }
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
    const progress = Math.min(100, (audio.currentTime / d) * 100);
    npProgressFill.style.width = progress + '%';
    npProgress.setAttribute('aria-valuenow', progress.toFixed(0));
    npCurrentTime.textContent = fmtClock(audio.currentTime);
    npDuration.textContent = fmtClock(d);
  }
});
audio.addEventListener('loadedmetadata', () => {
  if (isFinite(audio.duration) && audio.duration > 0) npDuration.textContent = fmtClock(audio.duration);
});
audio.addEventListener('ended', () => {
  if (!started || !current) return;
  const playedId = current.id;
  if (playedId) {
    const url = '/api/audio/played?id=' + encodeURIComponent(String(playedId));
    if (!navigator.sendBeacon || !navigator.sendBeacon(url)) {
      fetch(url, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
    }
  }
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

const artworkCache = new Map();
const ARTWORK_CACHE_LIMIT = 24;

function highResArtworkUrl(url) {
  // iTunes RSS 通常只给 100px 缩略图；同一 CDN 支持更适合唱片尺寸的版本。
  return url.replace(/\/\d{2,4}x\d{2,4}(?:bb)?(?=\.(?:jpe?g|png)(?:\?|$))/i, '/600x600bb');
}

function trimArtworkCache() {
  while (artworkCache.size > ARTWORK_CACHE_LIMIT) {
    const oldest = artworkCache.keys().next().value;
    if (!oldest || (current && oldest === current.artwork)) return;
    artworkCache.delete(oldest);
  }
}

function preloadArtwork(url) {
  if (!url) return Promise.resolve('');
  const cached = artworkCache.get(url);
  if (cached) return cached.ready;

  const candidates = [...new Set([highResArtworkUrl(url), url])];
  const entry = { image: null, resolvedUrl: candidates[0], ready: null };
  entry.ready = new Promise((resolve) => {
    let index = 0;
    const loadCandidate = () => {
      const image = new Image();
      entry.image = image;
      image.decoding = 'async';
      image.onload = () => {
        entry.resolvedUrl = candidates[index];
        resolve(entry.resolvedUrl);
      };
      image.onerror = () => {
        index++;
        if (index < candidates.length) loadCandidate();
        else {
          entry.resolvedUrl = '';
          resolve('');
        }
      };
      image.src = candidates[index];
    };
    loadCandidate();
  });
  artworkCache.set(url, entry);
  trimArtworkCache();
  return entry.ready;
}

function artworkUrlFor(url) {
  const cached = artworkCache.get(url);
  return cached ? cached.resolvedUrl : highResArtworkUrl(url);
}

function prefetch() {
  fetching = fetchSong()
    .then((s) => {
      nextSong = s;
      s.artworkReady = preloadArtwork(s.artwork);
    })
    .catch(() => { nextSong = null; });
}

// 歌曲开始后，异步解析艺术家国籍并点亮地球仪（未解析到时轮询）
let countryPollTimer = null;
let countryPollGeneration = 0;

function invalidateCountryPoll() {
  countryPollGeneration++;
  clearTimeout(countryPollTimer);
  countryPollTimer = null;
}

function pollCountry(id) {
  invalidateCountryPoll();
  const generation = countryPollGeneration;
  const songId = String(id);
  const isActive = () =>
    generation === countryPollGeneration && current && String(current.id) === songId;
  (async () => {
    for (let i = 0; i < 10; i++) {
      if (!isActive()) return;
      try {
        const r = await fetch('/api/country?id=' + encodeURIComponent(id));
        if (!r.ok) break;
        const j = await r.json();
        if (!isActive()) return;
        if (j.id != null && String(j.id) !== songId) return;
        if (j.countrycode) { applyCountry(j, songId); return; }
        if (j.status === 'none') {
          applyCountry(j, songId);
          return;
        }
      } catch (e) { /* 网络错误：稍后重试 */ }
      if (!isActive()) return;
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (isActive()) setCountry(null, '未知地区');
  })();
}

function applyCountry(j, expectedId) {
  const resultId = j.id != null ? String(j.id) : String(expectedId || '');
  if (!current || !resultId || String(current.id) !== resultId) return;
  setCountry(j.countrycode, j.country);
  current.countrycode = j.countrycode || '';
  current.country = j.country || '未知地区';
}

// 统一设置"当前国家"：更新高亮、让地球仪转过去并缩放、刷新显示
function setCountry(code, displayName) {
  code = /^[A-Z]{2}$/.test(code) ? code : null;
  if (code) code = displayCodeFor(code);
  if (code && map.aliases[code]) code = map.aliases[code];
  highlightCode = code; // 保留（即使该国家在地图上没有格子）
  // 定位与缩放：
  //  - 优先用首都作为信号点，让“针”而不是稀疏轮廓成为视觉焦点
  //  - 保持轻微推进，保留周边地理语境
  if (code) {
    // 像 Spidey Tracker 的 pin 一样，优先把“信号点”（首都）放到中心，
    // 而不是为了让微小国家的轮廓填满画面而无限放大。
    const focus = capitals[code] ||
      (countryLon[code] !== undefined ? [countryLat[code], countryLon[code]] : null);
    if (focus) {
      targetRot = focus[1];
      targetPitch = focus[0] || 0;
      targetZoom = countryZoom(code);
    } else {
      targetRot = null; targetPitch = 0; targetZoom = 1;
    }
  } else {
    targetRot = null; targetPitch = 0; targetZoom = 1;
  }
  // 显示
  const name = (code && DISPLAY_NAMES[code]) || displayName || (code && map.names[code]) || '未知地区';
  const flag = codeToFlag(code);
  npCountry.textContent = flag + ' ' + name;
  globeCountry.textContent = flag + ' ' + name;
  const cap = code && capitals[code];
  const lat = cap ? cap[0] : (code ? countryLat[code] : undefined);
  const lon = cap ? cap[1] : (code ? countryLon[code] : undefined);
  globeLat.textContent = fmtCoordinate(lat, 'N', 'S');
  globeLon.textContent = fmtCoordinate(lon, 'E', 'W');
  const pending = !code && displayName === '正在定位…';
  globeHint.textContent = code
    ? 'SIGNAL LOCKED · 已锁定'
    : pending ? 'LOOKUP IN PROGRESS · 正在解析' : 'NO VERIFIED DATA · 暂无可信资料';
  globeSignalCopy.textContent = code
    ? code + ' // TRACKING'
    : pending ? 'LOOKUP IN PROGRESS' : 'NO COUNTRY DATA';
  globePinCountry.textContent = code ? flag + ' ' + name : '——';
  globePin.classList.toggle('is-visible', Boolean(code));
  return code;
}

function setSong(s) {
  invalidateCountryPoll();
  setPlayingUI(false);
  setDeckBadge('LOADING', 'loading');
  current = s;
  trackNumber = (trackNumber % 99) + 1;
  npIndex.textContent = String(trackNumber).padStart(2, '0');
  setCountry(s.countrycode, s.countrycode ? s.country : '正在定位…');

  npStation.textContent = s.title;
  npMeta.textContent = [s.artist, s.album, fmtDuration(s.duration)].filter(Boolean).join(' · ');
  npProgressFill.style.width = '0%';
  npProgress.setAttribute('aria-valuenow', '0');
  npCurrentTime.textContent = '0:00';
  npDuration.textContent = fmtClock(s.duration);

  // 未带国家信息 → 后台解析（MusicBrainz 结构化资料），完成后地球仪亮起并转过去
  if (!s.countrycode && s.id) pollCountry(s.id);

  // 整张唱片与中心标签共用专辑海报；无封面时使用主题渐变
  let recordArtwork;
  if (s.artwork) {
    recordArtwork = 'url("' + artworkUrlFor(s.artwork) + '")';
  } else {
    const hue = hashHue(s.title + s.artist);
    recordArtwork =
      'radial-gradient(circle at 32% 30%, hsl(' + hue + ', 72%, 62%), hsl(' + hue + ', 70%, 42%) 70%)';
  }
  record.style.setProperty('--record-artwork', recordArtwork);
  label.style.setProperty('--record-artwork', recordArtwork);
  if (s.artwork) {
    (s.artworkReady || preloadArtwork(s.artwork)).then((resolvedUrl) => {
      if (current !== s || !resolvedUrl) return;
      const artwork = 'url("' + resolvedUrl + '")';
      record.style.setProperty('--record-artwork', artwork);
      label.style.setProperty('--record-artwork', artwork);
    });
  }
  labelTitle.textContent = s.title;
  labelArtist.textContent = s.artist;

  setStatus(started ? '连接中…' : '已准备 · 点击唱片开始播放');
  audio.src = s.streamUrl;
  audio.load();
  armWatchdog();
  if (started) {
    audio.play().catch(() => { /* 静默，等用户交互 */ });
  }
}

async function next() {
  const request = ++nextRequest;
  skipCount = 0;
  clearTimeout(autoTimer);
  setStatus('正在切换…');
  setDeckBadge('SEARCHING', 'loading');
  let s = nextSong;
  nextSong = null;
  if (!s) {
    try {
      s = await fetchSong();
    } catch (e) {
      if (request === nextRequest) {
        setStatus('获取歌曲失败，请重试');
        setDeckBadge('OFFLINE', 'loading');
      }
      return;
    }
  }
  if (request !== nextRequest) return;
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
const ZOOM_MIN = 1, ZOOM_MAX = 1.14; // 保留全球语境，视觉焦点交给信号 pin

// 夜航控制台配色：深海蓝 + 低饱和陆地 + 琥珀定位信号
const PAL = {
  skyBands: [[4, 12, 23], [5, 20, 34], [7, 31, 45], [10, 43, 52], [13, 55, 57]],
  rim: [53, 148, 140],
  star: [170, 224, 196],
  seaDeep: [3, 18, 34],
  seaMid: [5, 42, 61],
  seaLit: [13, 84, 96],
  seaGrid: [24, 89, 98],
  seaTexture: [16, 61, 73],
  coast: [91, 165, 139],
  countryLine: [21, 78, 70],
  landDark: [21, 56, 53],
  land: [46, 108, 88],
  landLit: [96, 164, 122],
  landTexture: [68, 133, 103],
  landGrid: [34, 91, 78],
  hiA: [255, 196, 80],
  hiB: [255, 240, 174],
  hiEdge: [255, 141, 77],
  flagRed: [255, 108, 92],
  pole: [226, 244, 211],
  poleDark: [79, 111, 104],
  markerGlow: [255, 206, 106],
};

let backdrop = null;   // 静态背景（梦幻天空+柔光+星空）
let frameImg = null;   // 复用的帧缓冲（避免每帧分配内存）
let coastMask = null;  // Uint8Array 海岸线边缘 bitmask
let countryMask = null; // Uint8Array 国界边缘 bitmask
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
  coastMask = new Uint8Array(W * H);
  countryMask = new Uint8Array(W * H);
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
      const idx = y * W + x;
      for (let i = 0; i < nb.length; i++) {
        const neighbor = nb[i];
        if (neighbor === '..' || neighbor === '') coastMask[idx] |= 1 << i;
        else if (neighbor !== c) countryMask[idx] |= 1 << i;
      }
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
  // 小国不再被放大成几块孤立像素；所有国家只做轻微的镜头推进，
  // 具体位置由固定尺寸的信号 pin 和档案卡承担。
  const z = 1.06 + Math.min(.42, Math.sqrt(area) / 42);
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

function nearGridLine(value, step = 15, tolerance = .42) {
  const half = step / 2;
  const wrapped = ((value + half) % step + step) % step - half;
  return Math.abs(wrapped) < tolerance;
}

function edgeHit(mask, fx, fy) {
  return ((mask & 1) && fx > .58) ||
    ((mask & 2) && fx < .42) ||
    ((mask & 4) && fy > .58) ||
    ((mask & 8) && fy < .42);
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

function positionGlobePin(pos) {
  if (!globeStage || !globePin || !pos.visible) {
    globePin.classList.remove('is-visible');
    return;
  }
  const canvasW = globe.clientWidth || GW;
  const canvasH = globe.clientHeight || GH;
  const scaleX = canvasW / GW;
  const scaleY = canvasH / GH;
  const offsetX = (globeStage.clientWidth - canvasW) / 2;
  const offsetY = (globeStage.clientHeight - canvasH) / 2;
  globePin.style.left = (offsetX + pos.x * scaleX) + 'px';
  globePin.style.top = (offsetY + pos.y * scaleY) + 'px';
  globePin.classList.toggle('pin-card-left', pos.x > GW * .58);
  globePin.classList.add('is-visible');
}

function drawGlobe(now) {
  if (!frameImg) frameImg = gctx.createImageData(GW, GH);
  const d = frameImg.data;
  if (backdrop) d.set(backdrop.data);
  if (!map.grid || !coastMask || !countryMask) {
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
      const mapX = ((lon + 180) / 360) * W;
      const mapY = ((90 - lat) / 180) * H;
      const gx = Math.min(W - 1, Math.max(0, Math.floor(mapX)));
      const gy = Math.min(H - 1, Math.max(0, Math.floor(mapY)));
      const fx = mapX - Math.floor(mapX);
      const fy = mapY - Math.floor(mapY);
      const cellIndex = gy * W + gx;
      const code = grid.substr((gy * W + gx) * 2, 2);
      const graticule = nearGridLine(lat) || nearGridLine(lon);

      let rgb;
      if (code === '..' || code === '') {
        rgb = graticule ? PAL.seaGrid :
          (((px * 13 + py * 7) & 31) === 0 ? PAL.seaTexture :
            dz > 0.92 ? PAL.seaLit : dz > 0.6 ? PAL.seaMid : PAL.seaDeep);
      } else {
        const isTarget = highlightCode && isHighlightedMapCode(code);
        const coast = edgeHit(coastMask[cellIndex], fx, fy);
        const countryEdge = edgeHit(countryMask[cellIndex], fx, fy);
        if (isTarget) rgb = countryEdge || coast ? PAL.hiEdge : hiCol;
        else if (coast) rgb = PAL.coast;
        else if (countryEdge) rgb = PAL.countryLine;
        else if (graticule) rgb = PAL.landGrid;
        else rgb = (((px * 7 + py * 11 + gx * 5 + gy * 3) & 47) === 0)
          ? PAL.landTexture
          : dz > 0.92 ? PAL.landLit : dz > 0.6 ? PAL.land : PAL.landDark;
      }
      // 球面光照：保留像素硬边，但让近地平线不再塌成一圈黑块
      const sh = .68 + dz * .32;
      setPx(d, px, py, [
        Math.min(255, (rgb[0] * sh) | 0),
        Math.min(255, (rgb[1] * sh) | 0),
        Math.min(255, (rgb[2] * sh) | 0),
      ]);
    }
  }

  // 首都标记：像素定位环 + HTML 信号卡，位置随球面旋转/缩放移动
  if (highlightCode) {
    const cap = capitals[highlightCode];
    const lat0 = cap ? cap[0] : countryLat[highlightCode];
    const lon0 = cap ? cap[1] : countryLon[highlightCode];
    if (lat0 !== undefined && lon0 !== undefined) {
      const pos = countryScreenPos(lat0, lon0);
      if (pos.visible) {
        positionGlobePin(pos);
        const mx = Math.round(pos.x);
        const my = Math.round(pos.y);
        const M = Math.max(1, Math.round(GR / 58)); // 标记随分辨率缩放
        const bounce = Math.round(Math.sin(now / 200) * M);
        const signalCol = pulse > 0.5 ? PAL.flagRed : PAL.hiB;
        const markerRadius = Math.max(5, Math.round(M * 5 + pulse * 2));
        drawPixelCircle(d, mx, my + bounce, markerRadius, PAL.markerGlow, .68);
        // 小型像素十字作为 HTML 信号 pin 的“落点”阴影
        const cross = Math.max(3, M * 2);
        for (let x = mx - cross; x <= mx + cross; x++) setPx(d, x, my + bounce, PAL.poleDark);
        for (let y = my - cross; y <= my + cross; y++) setPx(d, mx, y + bounce, PAL.poleDark);
        setPx(d, mx, my + bounce, signalCol);
      }
    } else {
      globePin.classList.remove('is-visible');
    }
  } else {
    globePin.classList.remove('is-visible');
  }

  gctx.putImageData(frameImg, 0, 0);
}

function updateGlobe() {
  if (targetRot !== null) {
    // 偏航（最短弧） + 俯仰 + 缩放 平滑趋近
    const delta = ((targetRot - rot + 540) % 360) - 180;
    if (Math.abs(delta) < 0.18) rot = targetRot;
    else rot += delta * 0.048;
    pitch += (targetPitch - pitch) * 0.042;
    zoom += (targetZoom - zoom) * 0.042;
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
function isFormTarget(target) {
  return target && typeof target.matches === 'function' &&
    (target.matches('input, textarea, select, button, [contenteditable="true"]') || target.closest('[role="dialog"]'));
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (isFormTarget(e.target)) return;
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
btnNext.addEventListener('click', () => { started = true; next(); });
record.addEventListener('click', () => { started = true; togglePlay(); });
settingsButton.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsSave.addEventListener('click', saveSettings);
settingsToggleKey.addEventListener('click', () => {
  const showing = settingsClientId.type === 'text';
  settingsClientId.type = showing ? 'password' : 'text';
  settingsToggleKey.textContent = showing ? '显示' : '隐藏';
});
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsModal.hidden) closeSettings();
});

async function loadAppInfo() {
  try {
    const response = await fetch('/api/info', { cache: 'no-store' });
    if (!response.ok) return;
    const info = await response.json();
    updateSourceLabels(info.mode);
  } catch (error) {
    updateSourceLabels('itunes');
  }
}

/* ---------------- 启动 ---------------- */
(async function init() {
  startBrowserSession();
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

  await loadAppInfo();

  // 默认先把第一首唱片和地图信息摆出来，避免用户面对空白首屏。
  // ?demo=1 / ?demo=true：用于展览和演示，打开页面即开始播放。
  const demoValue = new URLSearchParams(location.search).get('demo');
  started = demoValue === '1' || demoValue === 'true';
  await next();
  if (!started && current) {
    setDeckBadge('READY TO PLAY');
    setStatus('已准备 · 点击唱片或按 Space 播放');
  }
})();
