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
const npArtist = el('np-artist');
const transportTitle = el('transport-title');
const transportArtist = el('transport-artist');
const transportArtwork = el('transport-artwork');
const npStatus = el('np-status');
const npProgress = el('np-progress');
const npProgressFill = el('np-progress-fill');
const npCurrentTime = el('np-current-time');
const npDuration = el('np-duration');
const npMode = el('np-mode');
const npIndex = el('np-index');
const npRights = el('np-rights');
const npSourceLink = el('np-source-link');
const npLicenseLink = el('np-license-link');
const npRightsNote = el('np-rights-note');
const globeCountry = el('globe-country');
const globeCountryCode = el('globe-country-code');
const globeLocationStatus = el('globe-location-status');
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
const settingsButtonLabel = el('settings-button-label');
const settingsModal = el('settings-modal');
const settingsClose = el('settings-close');
const settingsCancel = el('settings-cancel');
const settingsSave = el('settings-save');
const settingsToggleKey = el('settings-toggle-key');
const settingsClientId = el('jamendo-client-id');
const settingsStatus = el('settings-status');
const settingsWebHelp = el('settings-web-help');

const globe = document.getElementById('globe');
const gctx = globe.getContext('2d');

/* ---------------- 状态 ---------------- */
let map = { w: 144, h: 72, grid: '', names: {}, aliases: {} };
let current = null;       // 当前歌曲
let nextSong = null;      // 预取的下一首
let fetching = null;      // 可取消的下一首预取
let activeSongRequest = null;
let started = false;      // 用户当前是否希望继续播放（暂停会取消自动恢复）
let playbackState = 'idle';
let skipCount = 0;
let watchdog = null;
let autoTimer = null;     // 歌曲结束自动切换的定时器
let highlightCode = null; // 当前高亮国家（像素地球仪）
let rot = 0;              // 地球仪旋转（经度，度）
let targetRot = null;     // 要转到的国家经度（null = 空闲自转）
let trackNumber = 0;
let nextRequest = 0;
let sourceMode = 'jamendo';
let serverStandby = false;
let personalQueues = false;
let listeningToken = '';
let listeningConnect = null;
let listeningHeartbeat = null;
let listeningSequence = 0;
let setupRequired = false;
let settingsReturnFocus = null;
let settingsGeneration = 0;
let settingsSaving = false;

const JAMENDO_HOSTS = new Set(['jamendo.com', 'www.jamendo.com']);
const CREATIVE_COMMONS_HOST = 'creativecommons.org';
const CREATIVE_COMMONS_LICENSES = new Map([
  ['by', 'BY'], ['by-sa', 'BY-SA'], ['by-nd', 'BY-ND'],
  ['by-nc', 'BY-NC'], ['by-nc-sa', 'BY-NC-SA'], ['by-nc-nd', 'BY-NC-ND'],
]);
const CREATIVE_COMMONS_VERSIONS = new Set(['1.0', '2.0', '2.5', '3.0', '4.0']);
const SETUP_REQUIRED_MESSAGE = '需要配置 Jamendo client_id · 请在设置中填写，或设置 JAMENDO_CLIENT_ID 后重启服务';

// 歌曲接口挂起时及时释放播放控制，避免实体按钮/网页长期停在切换状态。
// 首次初始化在线编号范围可能较慢；后续切歌无需等待整首音频或地区解析。
const SONG_REQUEST_TIMEOUT_MS = 45000;
const SONG_CANDIDATE_TTL_MS = 15 * 60 * 1000;
const APP_INFO_TIMEOUT_MS = 3000;
const GLOBE_RESOURCE_TIMEOUT_MS = 15000;
const COUNTRY_REQUEST_TIMEOUT_MS = 5000;
const SONG_FETCH_ERRORS = new Map([
  ['SESSION_CAPACITY', '当前使用人数较多，请稍后重试'],
  ['SESSION_RATE_LIMIT', '连接过于频繁，请稍后重试'],
  ['SONG_RATE_LIMIT', '切歌过于频繁，请稍后重试'],
  ['SONG_REQUEST_PENDING', '正在准备下一首，请稍候'],
  ['BUFFER_PREPARING', '正在准备歌曲，请稍后重试'],
  ['JAMENDO_NETWORK_ERROR', '暂时连接不上 Jamendo，请检查网络、DNS 或代理后重试'],
  ['JAMENDO_UPSTREAM_ERROR', 'Jamendo 服务暂时无法返回歌曲，请稍后重试'],
  ['JAMENDO_DISCOVERY_UNAVAILABLE', '暂时没有发现可播放的新歌曲，请稍后重试'],
]);

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
  if (!browserSessionId || serverStandby) return;
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

async function ensureListeningSession() {
  if (!personalQueues || listeningToken) return listeningToken;
  if (!listeningConnect) listeningConnect = (async () => {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),5000);
    try {
      const response=await fetch('/api/listening-session',{method:'POST',signal:controller.signal,cache:'no-store'});
      const data=await response.json();
      if (!response.ok || typeof data.token!=='string') {
        const error=new Error(SONG_FETCH_ERRORS.get(data.code) || '暂时无法建立播放连接，请稍后重试'); error.code=data.code; throw error;
      }
      listeningToken=data.token; listeningSequence=0;
      return listeningToken;
    } finally { clearTimeout(timer); }
  })().finally(()=>{listeningConnect=null;});
  return listeningConnect;
}

function sendListeningState(disconnect = false) {
  if (!personalQueues || !listeningToken) return;
  const token=listeningToken;
  const body=JSON.stringify({token,state:disconnect?'disconnect':'heartbeat',
    playing:started && !audio.paused,id:current?.id});
  if (disconnect && navigator.sendBeacon && navigator.sendBeacon('/api/listening-session',body)) return;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),5000);
  fetch('/api/listening-session',{method:'POST',body,keepalive:true,cache:'no-store',signal:controller.signal})
    .then(response=>{ if (response.status===401 && listeningToken===token) listeningToken=''; })
    .catch(()=>{}).finally(()=>clearTimeout(timer));
}

function startListeningSession() {
  if (listeningHeartbeat) return;
  ensureListeningSession().then(()=>sendListeningState()).catch(()=>{});
  listeningHeartbeat=setInterval(()=>{
    if (!listeningToken) ensureListeningSession().then(()=>sendListeningState()).catch(()=>{});
    else sendListeningState();
  },20000);
  // Hidden pages can still be playing. Server activity follows playback, not visibility.
  audio.addEventListener('playing',()=>sendListeningState());
  audio.addEventListener('pause',()=>sendListeningState());
  window.addEventListener('pagehide',event=>{
    if (!event.persisted) { clearInterval(listeningHeartbeat); sendListeningState(true); }
  });
}

/* ---------------- 工具 ---------------- */
function codeToFlag(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  return Array.from(code).map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
}

function setStatus(text) { npStatus.textContent = text; }

function setDeckBadge(text, state) {
  deckBadge.textContent = text;
  if (state) deckBadge.dataset.state = state;
  else delete deckBadge.dataset.state;
}

function normalizedTrackId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(id)) return '';
  const normalized = id.replace(/^0+(?=\d)/, '');
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : '';
}

function validateJamendoTrackUrl(value, trackId) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return '';
    if (!JAMENDO_HOSTS.has(url.hostname.toLowerCase())) return '';
    const match = url.pathname.match(/^\/track\/(\d+)\/?$/i);
    const id = normalizedTrackId(trackId);
    if (!match || (id && normalizedTrackId(match[1]) !== id)) return '';
    return 'https://www.jamendo.com/track/' + normalizedTrackId(match[1]);
  } catch (error) {
    return '';
  }
}

function validateLicense(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.url !== 'string') return null;
  let url;
  try {
    url = new URL(value.url);
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== CREATIVE_COMMONS_HOST ||
      url.username || url.password || url.port || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/licenses\/(by|by-sa|by-nd|by-nc|by-nc-sa|by-nc-nd)\/(1\.0|2\.0|2\.5|3\.0|4\.0)(?:\/([^/]+))?\/?$/i);
  if (!match) return null;
  const code = match[1].toLowerCase();
  const version = match[2];
  const suffix = match[3] || '';
  if (!CREATIVE_COMMONS_LICENSES.has(code) || !CREATIVE_COMMONS_VERSIONS.has(version) ||
      (suffix && !/^(?:[a-z]{2}(?:-[a-z]{2})?|deed\.[a-z]{2}(?:-[a-z]{2})?)$/i.test(suffix))) return null;
  const expectedName = 'CC ' + CREATIVE_COMMONS_LICENSES.get(code) + ' ' + version;
  if (value.name.trim() !== expectedName) return null;
  return { name: value.name.trim(), url: url.href };
}

function clearSafeLink(link) {
  if (!link) return;
  link.hidden = true;
  link.textContent = '';
  if (typeof link.removeAttribute === 'function') link.removeAttribute('href');
  else link.href = '';
}

function setSafeLink(link, text, href) {
  if (!link) return;
  clearSafeLink(link);
  if (!href) return;
  link.textContent = text;
  if (typeof link.setAttribute === 'function') link.setAttribute('href', href);
  else link.href = href;
  link.hidden = false;
}

function resetTrackRights() {
  clearSafeLink(npSourceLink);
  clearSafeLink(npLicenseLink);
  if (npRightsNote) npRightsNote.hidden = true;
  if (npRights) npRights.hidden = true;
}

function renderTrackRights(song) {
  resetTrackRights();
  const sourceHref = validateJamendoTrackUrl(song.sourceUrl, song.id);
  const license = validateLicense(song.license);
  setSafeLink(npSourceLink, '歌曲原页', sourceHref);
  setSafeLink(npLicenseLink, license ? license.name : '', license ? license.url : '');
  if (npRightsNote) npRightsNote.hidden = !license;
  if (npRights) npRights.hidden = !(sourceHref || license);
}

function setupMessage(message) {
  return typeof message === 'string' && message.trim() ? message : SETUP_REQUIRED_MESSAGE;
}

function showSetupRequired(message) {
  setupRequired = true;
  sourceMode = 'setup-required';
  started = false;
  nextRequest++;
  if (activeSongRequest) activeSongRequest.controller.abort();
  if (fetching) fetching.controller.abort();
  activeSongRequest = null;
  fetching = null;
  nextSong = null;
  clearPlaybackTimers();
  audio.pause();
  setPlaybackState('setup-required', setupMessage(message));
}

function updateSourceLabels(mode, configured) {
  const explicitlySetupRequired = mode === 'setup-required' || configured === false;
  if (explicitlySetupRequired) setupRequired = true;
  // Once the API has explicitly reported missing credentials, keep that
  // state for this page even if an earlier /api/info request arrives late.
  else if (!setupRequired && (mode === 'jamendo' || mode == null)) setupRequired = false;
  sourceMode = setupRequired ? 'setup-required' : 'jamendo';
  updateHeaderStatus();
  npMode.textContent = setupRequired ? 'SETUP REQUIRED' : 'JAMENDO FULL TRACK';
  sourceLink.textContent = 'Jamendo';
  sourceLink.href = 'https://www.jamendo.com';
  if (settingsButtonLabel) settingsButtonLabel.textContent = window.electronAPI ? 'Jamendo 设置' : '播放设置';
  if (settingsWebHelp) settingsWebHelp.hidden = Boolean(window.electronAPI);
  if (setupRequired) showSetupRequired();
}

function setSettingsStatus(text, isError) {
  settingsStatus.textContent = text || '';
  settingsStatus.style.color = isError ? '#ff8d7b' : '';
}

function closeSettings() {
  // Saving restarts the local service. Keep the dialog attached until the
  // result is known, otherwise a successful save can leave a stale setup page.
  if (settingsSaving) return;
  settingsGeneration++;
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
  if (settingsSaving) return;
  const generation = ++settingsGeneration;
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
    if (settingsWebHelp) settingsWebHelp.hidden = false;
    setSettingsStatus('浏览器版使用服务启动时的 JAMENDO_CLIENT_ID；按上方步骤配置后重启服务。', true);
    settingsClose.focus();
    return;
  }
  settingsClientId.disabled = true;
  settingsSave.disabled = true;
  settingsToggleKey.disabled = true;
  try {
    const settings = await window.electronAPI.getSettings();
    if (generation !== settingsGeneration) return;
    settingsClientId.value = settings.jamendoClientId || '';
    setSettingsStatus(settings.mode === 'jamendo' ? '当前模式：Jamendo 全曲' : '当前状态：需要配置 Jamendo client_id');
  } catch (error) {
    if (generation !== settingsGeneration) return;
    setSettingsStatus('读取设置失败，请重试。', true);
  } finally {
    if (generation === settingsGeneration) {
      settingsClientId.disabled = false;
      settingsSave.disabled = false;
      settingsToggleKey.disabled = false;
      settingsClientId.focus();
    }
  }
}

async function saveSettings() {
  if (!window.electronAPI || settingsSaving) return;
  const generation = settingsGeneration;
  settingsSaving = true;
  let reloading = false;
  settingsClose.disabled = true;
  settingsClientId.disabled = true;
  settingsSave.disabled = true;
  settingsCancel.disabled = true;
  settingsToggleKey.disabled = true;
  setSettingsStatus('正在保存并重启本地服务，请稍候…');
  try {
    const result = await window.electronAPI.saveJamendoClientId(settingsClientId.value);
    if (generation !== settingsGeneration) return;
    if (!result || !result.ok) {
      setSettingsStatus((result && result.error) || '保存失败，请重试。', true);
      settingsSave.disabled = false;
      settingsCancel.disabled = false;
      settingsToggleKey.disabled = false;
      return;
    }
    setSettingsStatus(result.mode === 'jamendo' ? '已切换到 Jamendo 全曲模式，正在刷新…' : '已停用播放，正在刷新设置状态…');
    reloading = true;
    setTimeout(() => {
      if (generation === settingsGeneration) window.location.reload();
    }, 350);
  } catch (error) {
    if (generation !== settingsGeneration) return;
    setSettingsStatus('保存失败，请重试。', true);
    settingsSave.disabled = false;
    settingsCancel.disabled = false;
    settingsToggleKey.disabled = false;
  } finally {
    if (!reloading) {
      settingsSaving = false;
      settingsClose.disabled = false;
      settingsClientId.disabled = false;
    }
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
  if (started || !audio.paused) {
    stopPlayback('paused', '已暂停 · 点击唱片继续播放');
    return;
  }
  if (setupRequired) {
    setPlaybackState('setup-required', SETUP_REQUIRED_MESSAGE);
    return;
  }
  started = true;
  skipCount = 0;
  if (!current) { next(); return; }
  requestPlayback();
}

function clearPlaybackTimers() {
  clearTimeout(watchdog);
  clearTimeout(autoTimer);
  watchdog = null;
  autoTimer = null;
}

function setPlaybackState(state, message) {
  playbackState = state;
  updateHeaderStatus();
  setPlayingUI(state === 'playing');
  const badge = {
    loading: '正在寻找下一首', buffering: '正在缓冲', retrying: '正在重试',
    offline: '网络已断开', error: '播放已停止', 'setup-required': '请先配置播放',
  }[state];
  if (badge) setDeckBadge(badge, 'loading');
  btnPlay.textContent = started ? '⏸' : '▶';
  btnPlay.setAttribute('aria-label', started ? '暂停' : '播放');
  btnPlay.setAttribute('aria-pressed', String(started));
  record.setAttribute('aria-label', started ? '暂停唱片' : '播放唱片');
  record.setAttribute('aria-pressed', String(started));
  if (state === 'setup-required') deckTipCopy.textContent = '请先配置 Jamendo client_id · 打开播放设置';
  else if (started && state !== 'playing') deckTipCopy.textContent = '正在准备播放 · 点击唱片暂停';
  else if (state === 'ready') deckTipCopy.textContent = '点击唱片或按空格开始播放';
  if (message) setStatus(message);
}

function updateHeaderStatus() {
  const state = setupRequired ? 'setup-required' : playbackState;
  headerStatusText.textContent = {
    playing: '正在播放', paused: '已暂停', ready: '准备就绪',
    loading: '正在选歌', buffering: '正在缓冲', retrying: '正在重试',
    offline: '网络已断开', error: '播放已停止', blocked: '点击开始播放',
    ended: '即将播放下一首', 'setup-required': '需要配置播放',
  }[state] || '准备音乐中';
  el('header-status').dataset.state = state;
}

function stopPlayback(state, message) {
  started = false;
  nextRequest++;
  if (activeSongRequest) activeSongRequest.controller.abort();
  if (fetching) fetching.controller.abort();
  activeSongRequest = null;
  fetching = null;
  clearPlaybackTimers();
  setPlaybackState(state, message);
  audio.pause();
}

function requestPlayback() {
  if (setupRequired) {
    setPlaybackState('setup-required', SETUP_REQUIRED_MESSAGE);
    return;
  }
  const request = nextRequest;
  setPlaybackState('buffering', '正在启动音频…');
  armWatchdog();
  audio.play().catch((error) => {
    if (request !== nextRequest || !started) return;
    if (error.name === 'NotAllowedError') {
      stopPlayback('blocked', '浏览器已阻止自动播放 · 点击播放继续');
    } else {
      autoSkip('播放失败，正在重试…');
    }
  });
}

function setPlayingUI(on) {
  deck.classList.toggle('playing', on);
  ledText.textContent = on ? '正在播放' : '静候下一段旋律';
  btnPlay.textContent = on ? '⏸' : '▶';
  btnPlay.setAttribute('aria-label', on ? '暂停' : '播放');
  btnPlay.setAttribute('aria-pressed', String(on));
  if (on) {
    setDeckBadge('正在播放', 'live');
    deckTipCopy.textContent = '正在播放 · 点击唱片暂停';
  } else if (current) {
    setDeckBadge('准备就绪');
    deckTipCopy.textContent = '点击唱片或按空格继续播放';
  }
}

function armWatchdog() {
  if (!started || watchdog !== null) return;
  const request = nextRequest;
  const position = audio.currentTime;
  watchdog = setTimeout(() => {
    watchdog = null;
    if (!started || request !== nextRequest) return;
    if (!audio.paused && audio.currentTime > position) {
      armWatchdog();
      return;
    }
    autoSkip('播放长时间未推进，正在换一首…');
  }, 10000);
}

function autoSkip(reason) {
  if (!started || playbackState === 'retrying') return;
  if (setupRequired) {
    showSetupRequired();
    return;
  }
  clearPlaybackTimers();
  if (navigator.onLine === false) {
    setPlaybackState('offline', '网络已断开 · 恢复连接后继续播放');
    audio.pause();
    return;
  }
  skipCount++;
  if (skipCount >= 8) {
    stopPlayback('error');
    setStatus('连续失败，已停止自动重试 · ' + reason);
    return;
  }
  setPlaybackState('retrying', reason);
  audio.pause();
  autoTimer = setTimeout(() => { autoTimer = null; next('retry'); }, Math.min(400 * 2 ** (skipCount - 1), 4000));
}

audio.addEventListener('playing', () => {
  if (!started || audio.paused || ['loading', 'retrying'].includes(playbackState)) return;
  skipCount = 0;
  clearPlaybackTimers();
  setPlaybackState('playing', current ? '播放中 · ' + current.title : '播放中');
  armWatchdog();
});
function onBuffering() {
  if (!started || !['playing', 'buffering'].includes(playbackState)) return;
  setPlaybackState('buffering', '缓冲中…');
  armWatchdog();
}
audio.addEventListener('waiting', onBuffering);
audio.addEventListener('stalled', onBuffering);
audio.addEventListener('pause', () => {
  if (audio.paused && !audio.ended && started && ['playing', 'buffering'].includes(playbackState)) {
    stopPlayback('paused', '已暂停 · 点击唱片继续播放');
  }
});
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
let releasedAudioSong = null;
function releaseSongAudio(song) {
  if (!song || releasedAudioSong === song) return;
  releasedAudioSong = song;
  const playedId = song.id;
  if (playedId) {
    const url = '/api/audio/played?id=' + encodeURIComponent(String(playedId));
    if (personalQueues) {
      if (listeningToken) fetch(url,{method:'POST',headers:{'X-Vinyl-Session':listeningToken},
        keepalive:true,cache:'no-store',signal:AbortSignal.timeout(5000)}).catch(()=>{});
      return;
    }
    if (!navigator.sendBeacon || !navigator.sendBeacon(url)) {
      fetch(url, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
    }
  }
}

audio.addEventListener('ended', () => {
  if (!started || !current) return;
  releaseSongAudio(current);
  clearPlaybackTimers();
  setPlaybackState('ended', '歌曲结束，自动播放下一首…');
  autoTimer = setTimeout(() => { autoTimer = null; next('ended'); }, 700);
});
audio.addEventListener('error', () => {
  if (started && current && ['playing', 'buffering'].includes(playbackState)) {
    autoSkip('音频加载失败，正在换一首…');
  }
});

/* ---------------- 歌曲切换 ---------------- */
function fetchSong() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SONG_REQUEST_TIMEOUT_MS);
  const promise = (async () => {
    let r;
    for (let attempt=0;attempt<2;attempt++) {
      let headers;
      if (personalQueues) {
        const token=await ensureListeningSession();
        if (controller.signal.aborted) throw new Error('Song request cancelled');
        headers={'X-Vinyl-Session':token,'X-Vinyl-Sequence':String(++listeningSequence)};
      }
      r=await fetch('/api/song',{signal:controller.signal,cache:'no-store',...(headers?{headers}:{})});
      if (personalQueues && r.status===401 && attempt===0) {
        if (listeningToken===headers['X-Vinyl-Session']) listeningToken='';
        continue;
      }
      break;
    }
    if (!r.ok) {
      if (personalQueues && r.status===401) listeningToken='';
      if ([401,409,429,503].includes(r.status)) {
        let detail = null;
        try { detail = await r.json(); } catch (error) { /* use the generic setup message */ }
        if (detail && detail.code === 'JAMENDO_SETUP_REQUIRED') {
          const setupError = new Error(setupMessage(detail.error));
          setupError.code = detail.code;
          throw setupError;
        }
        if (detail && SONG_FETCH_ERRORS.has(detail.code)) {
          // Only display our own copy. Upstream errors can contain URLs or
          // credentials and must never be reflected into the player.
          const error = new Error(SONG_FETCH_ERRORS.get(detail.code));
          error.code = detail.code;
          throw error;
        }
      }
      throw new Error('api ' + r.status);
    }
    const song = await r.json();
    if (!song || typeof song.streamUrl !== 'string' || !song.streamUrl) throw new Error('invalid song');
    // Cancellation can race with parsing a response that already arrived.
    // Release only cancelled results; an adopted prefetch remains usable.
    if (controller.signal.aborted) {
      releaseSongAudio(song);
      const error = new Error('song request cancelled');
      error.name = 'AbortError';
      throw error;
    }
    return song;
  })().finally(() => clearTimeout(timeout));
  return { controller, promise };
}

const artworkCache = new Map();
const ARTWORK_CACHE_LIMIT = 24;

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

  const candidates = [url];
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
  return cached ? cached.resolvedUrl : url;
}

function isFreshSongCandidate(song) {
  const fetchedAt = Number(song && song.fetchedAt);
  return !Number.isFinite(fetchedAt) || Date.now() - fetchedAt <= SONG_CANDIDATE_TTL_MS;
}

function discardSongCandidate(song) {
  if (song) releaseSongAudio(song);
}

async function awaitFreshSong(task, request) {
  let song = await task.promise;
  if (isFreshSongCandidate(song)) return song;
  discardSongCandidate(song);
  if (request !== nextRequest) return null;

  const replacement = fetchSong();
  activeSongRequest = replacement;
  try {
    song = await replacement.promise;
    if (!isFreshSongCandidate(song)) {
      discardSongCandidate(song);
      const staleError = new Error('stale song candidate');
      staleError.code = 'STALE_SONG';
      throw staleError;
    }
    return song;
  } finally {
    if (activeSongRequest === replacement) activeSongRequest = null;
  }
}

function prefetch() {
  if (serverStandby || setupRequired || sourceMode !== 'jamendo' || fetching || nextSong) return;
  const task = fetchSong();
  fetching = task;
  task.promise
    .then((s) => {
      if (fetching !== task) return;
      if (!isFreshSongCandidate(s)) {
        discardSongCandidate(s);
        return;
      }
      nextSong = s;
      s.artworkReady = preloadArtwork(s.artwork);
    })
    .catch((error) => {
      if (error && error.code === 'JAMENDO_SETUP_REQUIRED') showSetupRequired(error.message);
    })
    .finally(() => {
      if (fetching !== task) return;
      fetching = null;
    });
}

// 歌曲开始后，异步解析艺术家国籍并点亮地球仪（未解析到时轮询）
let countryPollTimer = null;
let countryPollGeneration = 0;
let countryPollController = null;

function invalidateCountryPoll() {
  countryPollGeneration++;
  clearTimeout(countryPollTimer);
  countryPollTimer = null;
  if (countryPollController) countryPollController.abort();
  countryPollController = null;
}

function pollCountry(id) {
  invalidateCountryPoll();
  const generation = countryPollGeneration;
  const songId = String(id);
  const isActive = () =>
    generation === countryPollGeneration && current && String(current.id) === songId;
  let attempts = 0;
  const lookup = async () => {
    if (!isActive()) return;
    const controller = new AbortController();
    countryPollController = controller;
    const timeout = setTimeout(() => controller.abort(), COUNTRY_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch('/api/country?id=' + encodeURIComponent(id), {
        signal: controller.signal, cache: 'no-store',
      });
      if (!isActive()) return;
      if (!r.ok) { setCountry(null, '未知地区'); return; }
      const j = await r.json();
      if (!isActive()) return;
      if (controller.signal.aborted) throw new Error('country request timed out');
      if (j.id != null && String(j.id) !== songId) return;
      if (j.countrycode || j.status === 'none') { applyCountry(j, songId); return; }
    } catch (e) { /* 网络错误或超时：仅当前歌曲稍后重试 */ }
    finally {
      clearTimeout(timeout);
      if (countryPollController === controller) countryPollController = null;
    }
    if (!isActive()) return;
    if (++attempts >= 10) { setCountry(null, '未知地区'); return; }
    countryPollTimer = setTimeout(() => {
      countryPollTimer = null;
      lookup();
    }, 2500);
  };
  lookup();
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
  globeCountry.textContent = name;
  globeCountryCode.textContent = code || '—';
  const cap = code && capitals[code];
  const lat = cap ? cap[0] : (code ? countryLat[code] : undefined);
  const lon = cap ? cap[1] : (code ? countryLon[code] : undefined);
  globeLat.textContent = fmtCoordinate(lat, 'N', 'S');
  globeLon.textContent = fmtCoordinate(lon, 'E', 'W');
  const pending = !code && displayName === '正在定位…';
  globeLocationStatus.textContent = code ? '已定位' : pending ? '正在定位' : '未知地区';
  globeLocationStatus.dataset.state = code ? 'resolved' : pending ? 'pending' : 'unknown';
  globeHint.textContent = code
    ? '艺人来源或活动地区'
    : pending ? '正在查询艺人地区' : '暂无可信地区资料';
  globeSignalCopy.textContent = code
    ? '已定位 · ' + code
    : pending ? '正在定位' : '未知地区';
  globePinCountry.textContent = code ? flag + ' ' + name : '——';
  globePin.classList.toggle('is-visible', Boolean(code));
  return code;
}

function setSong(s) {
  invalidateCountryPoll();
  const previous = current;
  current = s;
  renderTrackRights(s);
  trackNumber = (trackNumber % 99) + 1;
  npIndex.textContent = String(trackNumber).padStart(2, '0');
  setCountry(s.countrycode, s.countrycode ? s.country : '正在定位…');

  npStation.textContent = s.title;
  npArtist.textContent = s.artist || '未知艺人';
  transportTitle.textContent = s.title;
  transportArtist.textContent = s.artist || '未知艺人';
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
    recordArtwork = 'url("record-sleeve.svg")';
  }
  transportArtwork.style.backgroundImage = recordArtwork;
  record.style.setProperty('--record-artwork', recordArtwork);
  label.style.setProperty('--record-artwork', recordArtwork);
  if (s.artwork) {
    (s.artworkReady || preloadArtwork(s.artwork)).then((resolvedUrl) => {
      if (current !== s || !resolvedUrl) return;
      const artwork = 'url("' + resolvedUrl + '")';
      record.style.setProperty('--record-artwork', artwork);
      label.style.setProperty('--record-artwork', artwork);
      transportArtwork.style.backgroundImage = artwork;
    });
  }
  labelTitle.textContent = s.title;
  labelArtist.textContent = s.artist;

  audio.src = s.streamUrl;
  audio.load();
  // The replacement is ready and the browser has detached the previous source.
  // Preserve the current cache when pausing or when fetching a replacement fails.
  if (previous && previous.id !== s.id) releaseSongAudio(previous);
  if (started) requestPlayback();
  else setPlaybackState('ready', '已准备 · 点击唱片开始播放');
}

async function next(reason = 'manual') {
  if (setupRequired) {
    started = false;
    setPlaybackState('setup-required', SETUP_REQUIRED_MESSAGE);
    return;
  }
  const request = ++nextRequest;
  if (activeSongRequest) activeSongRequest.controller.abort();
  activeSongRequest = null;
  if (reason === 'manual') { skipCount = 0; started = true; }
  clearPlaybackTimers();
  setPlaybackState('loading', '正在切换…');
  audio.pause();
  let s = nextSong;
  nextSong = null;
  if (s && !isFreshSongCandidate(s)) {
    discardSongCandidate(s);
    s = null;
  }
  if (!s) {
    // 接管正在进行的预取；再次切歌时取消它，迟到的响应不能写回下一首。
    const task = fetching || fetchSong();
    fetching = null;
    activeSongRequest = task;
    try {
      s = await awaitFreshSong(task, request);
    } catch (e) {
      if (request === nextRequest) {
        if (e && e.code === 'JAMENDO_SETUP_REQUIRED') showSetupRequired(e.message);
        else if (e && SONG_FETCH_ERRORS.has(e.code)) {
          if (started) autoSkip(e.message);
          else setPlaybackState('error', e.message);
        }
        else if (started) autoSkip('获取歌曲失败，正在重试…');
        else setPlaybackState(navigator.onLine === false ? 'offline' : 'error', '获取歌曲失败或超时 · 点击播放重试');
      }
      return;
    } finally {
      if (activeSongRequest === task) activeSongRequest = null;
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

// 暖白唱片室：纸白海洋、墨绿陆地与黄铜定位点。
const PAL = {
  paper: [245, 242, 234],
  rim: [169, 183, 162],
  seaGrid: [187, 199, 177],
  coast: [59, 91, 72],
  countryLine: [90, 119, 96],
  landDark: [67, 94, 76],
  land: [63, 102, 79],
  landLit: [69, 108, 83],
  landTexture: [86, 119, 94],
  landGrid: [97, 125, 101],
  hiA: [172, 133, 84],
  hiB: [182, 147, 98],
  hiEdge: [148, 108, 64],
  flagRed: [168, 124, 72],
  poleDark: [75, 95, 77],
  markerGlow: [185, 145, 91],
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

// 静态纸白背景只生成一次，帧缓冲重复使用。
function buildBackdrop() {
  backdrop = gctx.createImageData(GW, GH);
  const d = backdrop.data;
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = (y * GW + x) * 4;
      d[i] = PAL.paper[0]; d[i + 1] = PAL.paper[1]; d[i + 2] = PAL.paper[2]; d[i + 3] = 255;
    }
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

// Selected preview: ripple, standard speed. Rings follow the sphere rather
// than sliding across the screen; the actual geographic marker stays fixed.
const GLOBE_RIPPLE_MS = 3600;
const GLOBE_RIPPLE_COUNT = 3;
const SIGNAL_AMBER = [224, 159, 72];
const SIGNAL_RING = [207, 146, 66];

function countryRippleColor(now, lat, lon, originLat, originLon, edge) {
  if (!Number.isFinite(originLat) || !Number.isFinite(originLon)) return PAL.hiB;
  const a = lat * Math.PI / 180, b = originLat * Math.PI / 180;
  const distance = Math.acos(Math.max(-1, Math.min(1,
    Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lon - originLon) * Math.PI / 180))));
  const wave = .5 + .5 * Math.cos(distance * 31 - now / 610);
  const strength = .24 + .71 * Math.pow(wave, 5);
  const base = edge ? [143, 111, 65] : [158, 130, 79];
  return base.map((value, i) => Math.round(value + ([239, 182, 94][i] - value) * strength));
}

function drawCountryRipple(d, pos, latDeg, lonDeg, now) {
  const mx = Math.round(pos.x), my = Math.round(pos.y);
  // A restrained glow underneath the pixel rings keeps the paper background.
  const glowRadius = 20;
  for (let y = -glowRadius; y <= glowRadius; y++) {
    for (let x = -glowRadius; x <= glowRadius; x++) {
      const radius2 = (x * x + y * y) / (glowRadius * glowRadius);
      if (radius2 < 1) blendPx(d, mx + x, my + y, SIGNAL_AMBER, .24 * Math.pow(1 - radius2, 2));
    }
  }
  const lat0 = latDeg * Math.PI / 180, lon0 = lonDeg * Math.PI / 180;
  const sinLat = Math.sin(lat0), cosLat = Math.cos(lat0);
  for (let ring = 0; ring < GLOBE_RIPPLE_COUNT; ring++) {
    const phase = (now / GLOBE_RIPPLE_MS + ring / GLOBE_RIPPLE_COUNT) % 1;
    const radius = .045 + phase * .40;
    const sinRadius = Math.sin(radius), cosRadius = Math.cos(radius);
    const alpha = .78 * Math.pow(1 - phase, 1.5);
    for (let point = 0; point < 112; point++) {
      if (point % 4 === 3) continue; // Deliberately dotted, like the map itself.
      const bearing = point / 112 * Math.PI * 2;
      const lat = Math.asin(Math.max(-1, Math.min(1,
        sinLat * cosRadius + cosLat * sinRadius * Math.cos(bearing))));
      const lon = lon0 + Math.atan2(Math.sin(bearing) * sinRadius * cosLat,
        cosRadius - sinLat * Math.sin(lat));
      const projected = countryScreenPos(lat * 180 / Math.PI, lon * 180 / Math.PI);
      if (projected.visible) blendPx(d, Math.round(projected.x), Math.round(projected.y), SIGNAL_RING, alpha);
    }
  }
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) blendPx(d, mx + x, my + y, [242, 183, 92], .85);
  setPx(d, mx, my, [255, 234, 183]);
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

  const capital = highlightCode && capitals[highlightCode];
  const originLat = capital ? capital[0] : countryLat[highlightCode];
  const originLon = capital ? capital[1] : countryLon[highlightCode];
  const W = map.w, H = map.h, grid = map.grid;
  const Rz = GR * zoom;
  const pRad = (pitch * Math.PI) / 180;
  const cosp = Math.cos(pRad), sinp = Math.sin(pRad);

  // 球体渲染（正交投影 + 任意方向旋转 + 缩放）
  // One projection per 3px tile rather than per screen pixel. Besides matching
  // the pixel globe, this avoids nine redundant sets of trigonometric work.
  const step = 3;
  drawPixelCircle(d, GCX, GCY, Rz, PAL.rim, .5);
  for (let py = 0; py < GH; py += step) {
    for (let px = 0; px < GW; px += step) {
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
        if (graticule) setPx(d, px, py, PAL.seaGrid);
        continue;
      } else {
        const isTarget = highlightCode && isHighlightedMapCode(code);
        const coast = edgeHit(coastMask[cellIndex], fx, fy);
        const countryEdge = edgeHit(countryMask[cellIndex], fx, fy);
        if (isTarget) rgb = countryRippleColor(now, lat, lon, originLat, originLon, countryEdge || coast);
        else if (coast) rgb = PAL.coast;
        else if (countryEdge) rgb = PAL.countryLine;
        else if (graticule) rgb = PAL.landGrid;
        else rgb = (((px * 7 + py * 11 + gx * 5 + gy * 3) & 47) === 0)
          ? PAL.landTexture
          : dz > 0.92 ? PAL.landLit : dz > 0.6 ? PAL.land : PAL.landDark;
      }
      // 球面光照：保留像素硬边，但让近地平线不再塌成一圈黑块
      const sh = .9 + dz * .1;
      const color = [
        Math.min(255, (rgb[0] * sh) | 0),
        Math.min(255, (rgb[1] * sh) | 0),
        Math.min(255, (rgb[2] * sh) | 0),
      ];
      // A 1px paper gap keeps the square dots distinct when enlarged by CSS.
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) setPx(d, px + ox, py + oy, color);
    }
  }

  // 定位点保持准确，涟漪沿地球曲面扩散，不再上下跳动。
  if (highlightCode) {
    const lat0 = originLat;
    const lon0 = originLon;
    if (lat0 !== undefined && lon0 !== undefined) {
      const pos = countryScreenPos(lat0, lon0);
      if (pos.visible) {
        positionGlobePin(pos);
        drawCountryRipple(d, pos, lat0, lon0, now);
      }
    } else {
      globePin.classList.remove('is-visible');
    }
  } else {
    globePin.classList.remove('is-visible');
  }

  gctx.putImageData(frameImg, 0, 0);
}

function updateGlobe(elapsedMs = 1000 / 60) {
  // Preserve the original 60Hz motion while allowing a lower drawing rate.
  const frames = elapsedMs / (1000 / 60);
  if (targetRot !== null) {
    // 偏航（最短弧） + 俯仰 + 缩放 平滑趋近
    const delta = ((targetRot - rot + 540) % 360) - 180;
    if (Math.abs(delta) < 0.18) rot = targetRot;
    else rot += delta * (1 - Math.pow(1 - 0.048, frames));
    const easing = 1 - Math.pow(1 - 0.042, frames);
    pitch += (targetPitch - pitch) * easing;
    zoom += (targetZoom - zoom) * easing;
  } else {
    rot = (rot + 0.06 * frames + 360) % 360;
    const easing = 1 - Math.pow(1 - 0.03, frames);
    pitch += (0 - pitch) * easing;
    zoom += (1 - zoom) * easing;
  }
}

const GLOBE_FRAME_MS = 1000 / 30;
let lastGlobeUpdate = null;
let nextGlobeFrame = 0;
let globeSignalTime = 0;
const globeMotionPreference = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let reduceGlobeMotion = Boolean(globeMotionPreference && globeMotionPreference.matches);
if (globeMotionPreference && typeof globeMotionPreference.addEventListener === 'function') {
  globeMotionPreference.addEventListener('change', event => {
    reduceGlobeMotion = event.matches;
    lastGlobeUpdate = null;
  });
}
function globeLoop(t) {
  requestAnimationFrame(globeLoop);
  if (document.hidden) {
    lastGlobeUpdate = null;
    return;
  }
  if (lastGlobeUpdate === null) nextGlobeFrame = t;
  if (t + 0.01 < nextGlobeFrame) return;
  // Keep the schedule aligned across 60/120/144Hz screens without accumulating drift.
  const frameMs = reduceGlobeMotion ? 250 : GLOBE_FRAME_MS;
  nextGlobeFrame += (Math.floor((t - nextGlobeFrame + 0.01) / frameMs) + 1) * frameMs;
  const elapsed = lastGlobeUpdate === null ? 0 : Math.min(100, t - lastGlobeUpdate);
  lastGlobeUpdate = t;
  if (reduceGlobeMotion) {
    if (targetRot !== null) { rot = targetRot; pitch = targetPitch; zoom = targetZoom; }
  } else {
    updateGlobe(elapsed);
    globeSignalTime += elapsed;
  }
  drawGlobe(reduceGlobeMotion ? 0 : globeSignalTime);
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
    next();
  } else if (k === ' ') {
    e.preventDefault();
    togglePlay();
  }
});

btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', () => next());
record.addEventListener('click', togglePlay);
record.addEventListener('keydown', (event) => {
  if (event.repeat || !['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  togglePlay();
});
window.addEventListener('online', () => {
  if (playbackState !== 'offline') return;
  if (started) next('retry');
  else if (!current) next('initial');
});
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

async function fetchStartupJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('startup resource ' + response.status);
    const data = await response.json();
    if (controller.signal.aborted) throw new Error('startup resource timed out');
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function loadGlobeResources() {
  // Each resource can finish independently; neither is required to prepare audio.
  fetchStartupJson('map.json', GLOBE_RESOURCE_TIMEOUT_MS).then((data) => {
    map = data;
    buildGlobeData();
    if (current && current.countrycode) setCountry(current.countrycode, current.country);
  }).catch((error) => console.warn('map.json 加载失败', error));
  fetchStartupJson('capitals.json', GLOBE_RESOURCE_TIMEOUT_MS).then((data) => {
    capitals = data;
    if (current && current.countrycode) setCountry(current.countrycode, current.country);
  }).catch((error) => console.warn('capitals.json 加载失败', error));
}

async function loadAppInfo() {
  try {
    const info = await fetchStartupJson('/api/info', APP_INFO_TIMEOUT_MS);
    serverStandby = info.serverMode === true;
    if (serverStandby) {
      clearInterval(browserHeartbeat);
      // A slow initial mode check may have allowed legacy prefetch. Once the
      // server is identified, hand look-ahead ownership back to its queues.
      if (fetching) {
        const obsolete=fetching; fetching=null; obsolete.controller.abort();
        obsolete.promise.then(discardSongCandidate).catch(()=>{});
      }
      if (nextSong) { discardSongCandidate(nextSong); nextSong=null; }
    }
    personalQueues=serverStandby && info.personalQueues===true;
    if (personalQueues) startListeningSession();
    updateSourceLabels(info.mode, info.configured);
  } catch (error) {
    updateSourceLabels('jamendo');
    // Keep first playback usable during a transient failure, but never leave a
    // public server page permanently running in the fallback desktop mode.
    setTimeout(()=>loadAppInfo(),5000);
  }
}

/* ---------------- 启动 ---------------- */
(async function init() {
  // 只在启动时读取演示意愿；异步初始化完成后不能覆盖用户已做出的操作。
  const demoValue = new URLSearchParams(location.search).get('demo');
  started = demoValue === '1' || demoValue === 'true';
  startBrowserSession();
  globe.width = GW;
  globe.height = GH;
  buildBackdrop();
  requestAnimationFrame(globeLoop);
  loadGlobeResources();
  await loadAppInfo();

  // 默认先把第一首唱片和地图信息摆出来，避免用户面对空白首屏。
  // ?demo=1 / ?demo=true：用于展览和演示，打开页面即开始播放。
  if (nextRequest === 0) await next('initial');
})();
