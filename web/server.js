'use strict';
// 世界唱片机 —— 后端
//  数据源：Jamendo（个人非商业原型，全曲播放）。需要免费 client_id：
//  https://devportal.jamendo.com ，填入 data/config.json 或环境变量。
//  API：
//     GET /api/song            随机国家 → 随机歌曲
//     GET /api/song?country=XX 指定国家 → 随机歌曲
//     GET /api/countries       已缓存国家列表
//     GET /api/info            统计信息
//  静态：托管 public/
// 运行：node web/server.js   （Node >= 18，无任何第三方依赖）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { clearLegacyRuntimeCache, clearRuntimeCache } = require('../runtime-cache');
const { lookupJamendoCountry, selectLocation, countryCodes: artistCountryCodes } = require('./jamendo-country');
const { createDiscovery } = require('./random-discovery');
const { normalizeJamendoTrack } = require('./jamendo-metadata');
const verifiedCountries = require('./verified-artist-countries.json');
const jamendoCountrySeed = require('./jamendo-country-seed.json');
const {
  extractMusicBrainzCountryCode,
  selectMusicBrainzArtist,
  selectMusicBrainzCountryCode,
} = require('./country-resolver');

const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, '..');
// Electron 将可写数据放到用户目录；直接运行 node web/server.js 时仍沿用项目内的 data/。
const DATA_ROOT = path.resolve(process.env.WORLD_VINYL_DATA_DIR || path.join(PROJECT_ROOT, 'data'));
const PUBLIC = path.resolve(process.env.WORLD_VINYL_PUBLIC_DIR || path.join(ROOT, 'public'));
const PORT = Number(process.env.PORT || process.env.WORLD_VINYL_PORT || 3000);
const HOST = process.env.WORLD_VINYL_HOST || '127.0.0.1';
const UA = 'vinyl-globe/1.0 (world vinyl turntable)';
const REQ_TIMEOUT = 12000;              // 单次数据源请求超时
const REFRESH_MS = 12 * 3600 * 1000;    // 每 12 小时整体刷新一次缓存
// 优先使用核实资料、Jamendo 艺术家声明地区，MusicBrainz 补充；不从语言猜国籍。
const TRUSTED_COUNTRY_SOURCES = new Set(['mb', 'jamendo', 'verified']);
const CACHEABLE_COUNTRY_SOURCES = new Set([...TRUSTED_COUNTRY_SOURCES, 'none']);
// Bump when the resolver logic changes so stale negative results are retried.
const COUNTRY_RESOLVER_VERSION = 9;

// ---- 配置：Jamendo client_id（环境变量优先，其次 data/config.json）----
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}
const JAMENDO_ID = (process.env.JAMENDO_CLIENT_ID || loadConfig().jamendoClientId || '').trim();
const MODE = JAMENDO_ID ? 'jamendo' : 'setup-required';
const AUDIO_DIR = path.join(DATA_ROOT, 'audio');   // 音频本地缓存（预下载）
const AUDIO_MAX = 3;                     // 最多保留 3 首已完整缓存的歌曲
const AUDIO_MAX_BYTES = 16 * 1024 * 1024; // 单首及其临时文件上限
const AUDIO_TOTAL_MAX_BYTES = 48 * 1024 * 1024; // 完整文件 + 临时文件总预算
const AUDIO_TTL_MS = 15 * 60 * 1000;     // 运行时音频和未播放候选的有效期
const AUDIO_CLEANUP_MS = 60 * 1000;
const WARM_MAX = 1;                      // 同时只下载一首，优先保障当前播放
const WARM_TARGET = 2;                   // 准备两首待播音频，给连续切歌留出余裕
const COUNTRY_CACHE_TTL = 30 * 86400 * 1000;
const COUNTRY_NONE_TTL = 86400 * 1000;
const COUNTRY_PREFETCH_TARGET = 16; // 与音频预缓存同一批，提前准备国家/地区

let shuttingDown = false;
let cacheCleared = false;

function clearRuntimeCacheOnce(reportErrors) {
  if (cacheCleared) return 0;
  cacheCleared = true;
  return clearRuntimeCache(
    DATA_ROOT,
    reportErrors ? (error) => console.warn('[songs] cache cleanup failed: ' + error.message) : undefined,
  );
}

function clearCacheBeforeDirectExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const removed = clearRuntimeCacheOnce(true);
  console.log('[songs] runtime cache cleared; config.json preserved (' + removed + ' entries)');
  process.exit(0);
}

// Electron 后端由主进程统一清理；直接运行 start.bat 时处理 Ctrl+C、关闭窗口等退出路径。
if (process.env.WORLD_VINYL_CLEAR_CACHE_ON_EXIT !== '0') {
  // Windows 关闭控制台窗口会发送 SIGHUP；Ctrl+Break 使用 SIGBREAK。
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.once(signal, clearCacheBeforeDirectExit);
    } catch (error) {
      // 当前平台不支持该信号时忽略，exit 事件仍会提供同步兜底。
    }
  }

  // 无法捕获的异常退出路径也会触发 exit；这里不能做异步工作，所以清理函数必须同步。
  process.once('exit', () => clearRuntimeCacheOnce(false));
}

// A previous process may have been killed before its exit hook ran.  Purge
// only restorable playback artifacts on every startup, including when exit
// cleanup is explicitly disabled (Electron performs its own final cleanup).
const startupRemoved = clearLegacyRuntimeCache(
  DATA_ROOT,
  (error) => console.warn('[songs] startup cache cleanup failed: ' + error.message),
);
if (startupRemoved) {
  console.log('[songs] startup playback cache purged (' + startupRemoved + ' entries)');
}

// 直接 Web 模式还要感知浏览器页面是否全部关闭；Electron 由主进程管理窗口生命周期。
const BROWSER_LIFECYCLE =
  process.env.WORLD_VINYL_BROWSER_LIFECYCLE === '1' ||
  (process.env.WORLD_VINYL_BROWSER_LIFECYCLE !== '0' && process.env.WORLD_VINYL_CLEAR_CACHE_ON_EXIT !== '0');
const BROWSER_SESSION_TTL = 45 * 1000;
const BROWSER_SHUTDOWN_GRACE = 1500;
const browserSessions = new Map();
let browserSessionSeen = false;
let browserShutdownTimer = null;
let browserSessionSweep = null;

function isValidBrowserSessionId(id) {
  return /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

function cancelBrowserShutdown() {
  if (!browserShutdownTimer) return;
  clearTimeout(browserShutdownTimer);
  browserShutdownTimer = null;
}

function shutdownAfterBrowserClose() {
  if (shuttingDown) return;
  shuttingDown = true;
  const removed = clearRuntimeCacheOnce(true);
  console.log('[songs] browser window closed; runtime cache cleared; config.json preserved (' + removed + ' entries)');
  if (browserSessionSweep) clearInterval(browserSessionSweep);
  const forceExit = setTimeout(() => process.exit(0), 1000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

function scheduleBrowserShutdown() {
  if (!BROWSER_LIFECYCLE || !browserSessionSeen || shuttingDown || browserSessions.size || browserShutdownTimer) return;
  browserShutdownTimer = setTimeout(() => {
    browserShutdownTimer = null;
    if (!browserSessions.size) shutdownAfterBrowserClose();
  }, BROWSER_SHUTDOWN_GRACE);
  browserShutdownTimer.unref();
}

function sweepBrowserSessions() {
  const cutoff = Date.now() - BROWSER_SESSION_TTL;
  for (const [id, lastSeen] of browserSessions) {
    if (lastSeen < cutoff) browserSessions.delete(id);
  }
  scheduleBrowserShutdown();
}

function updateBrowserSession(id, state) {
  if (!BROWSER_LIFECYCLE || !isValidBrowserSessionId(id)) return;
  if (state === 'disconnect') {
    browserSessions.delete(id);
    scheduleBrowserShutdown();
    return;
  }
  browserSessionSeen = true;
  browserSessions.set(id, Date.now());
  cancelBrowserShutdown();
}

if (BROWSER_LIFECYCLE) {
  sweepBrowserSessions();
  browserSessionSweep = setInterval(sweepBrowserSessions, 15 * 1000);
  browserSessionSweep.unref();
}

// ---------------------------------------------------------------- 国家名称
// Artist-location responses use ISO 3166-1 alpha-2 codes. Country selection
// is intentionally not exposed by the Jamendo prototype API.
const COUNTRY_CODES = [
  'AD','AE','AG','AI','AL','AM','AO','AR','AT','AU','AZ','BB','BE','BF','BG','BH',
  'BJ','BM','BN','BO','BR','BS','BT','BW','BY','BZ','CA','CG','CH','CI','CL','CM',
  'CN','CO','CR','CV','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE','EG','ES',
  'FI','FJ','FR','GA','GB','GD','GH','GM','GR','GT','GW','GY','HK','HN','HR','HU',
  'ID','IE','IL','IN','IS','IT','JM','JO','JP','KE','KG','KH','KN','KR','KW','KY',
  'KZ','LA','LB','LC','LK','LR','LT','LU','LV','MD','MG','MK','ML','MN','MO','MR',
  'MS','MT','MU','MW','MX','MY','MZ','NA','NE','NG','NI','NL','NO','NP','NZ','OM',
  'PA','PE','PG','PH','PK','PL','PT','PW','PY','QA','RO','RU','RW','SA','SB','SC',
  'SE','SG','SI','SK','SL','SN','SR','ST','SV','SZ','TC','TD','TG','TH','TJ','TM',
  'TN','TR','TT','TW','TZ','UA','UG','US','UY','UZ','VC','VE','VG','VN','YE','ZA',
  'ZM','ZW',
];

const COUNTRY_NAMES = {
  AD:'安道尔', AE:'阿联酋', AG:'安提瓜和巴布达', AI:'安圭拉', AL:'阿尔巴尼亚',
  AM:'亚美尼亚', AO:'安哥拉', AR:'阿根廷', AT:'奥地利', AU:'澳大利亚', AZ:'阿塞拜疆',
  BB:'巴巴多斯', BE:'比利时', BF:'布基纳法索', BG:'保加利亚', BH:'巴林', BJ:'贝宁',
  BM:'百慕大', BN:'文莱', BO:'玻利维亚', BR:'巴西', BS:'巴哈马', BT:'不丹',
  BW:'博茨瓦纳', BY:'白俄罗斯', BZ:'伯利兹', CA:'加拿大', CG:'刚果(布)', CH:'瑞士',
  CI:'科特迪瓦', CL:'智利', CM:'喀麦隆', CN:'中国', CO:'哥伦比亚', CR:'哥斯达黎加',
  CV:'佛得角', CY:'塞浦路斯', CZ:'捷克', DE:'德国', DJ:'吉布提', DK:'丹麦',
  DM:'多米尼克', DO:'多米尼加', DZ:'阿尔及利亚', EC:'厄瓜多尔', EE:'爱沙尼亚',
  EG:'埃及', ES:'西班牙', FI:'芬兰', FJ:'斐济', FR:'法国', GA:'加蓬', GB:'英国',
  GD:'格林纳达', GH:'加纳', GM:'冈比亚', GR:'希腊', GT:'危地马拉', GW:'几内亚比绍',
  GY:'圭亚那', HK:'中国香港', HN:'洪都拉斯', HR:'克罗地亚', HU:'匈牙利', ID:'印度尼西亚',
  IE:'爱尔兰', IL:'以色列', IN:'印度', IS:'冰岛', IT:'意大利', JM:'牙买加', JO:'约旦',
  JP:'日本', KE:'肯尼亚', KG:'吉尔吉斯斯坦', KH:'柬埔寨', KN:'圣基茨和尼维斯',
  KR:'韩国', KW:'科威特', KY:'开曼群岛', KZ:'哈萨克斯坦', LA:'老挝', LB:'黎巴嫩',
  LC:'圣卢西亚', LK:'斯里兰卡', LR:'利比里亚', LT:'立陶宛', LU:'卢森堡', LV:'拉脱维亚',
  MD:'摩尔多瓦', MG:'马达加斯加', MK:'北马其顿', ML:'马里', MN:'蒙古', MO:'中国澳门',
  MR:'毛里塔尼亚', MS:'蒙特塞拉特', MT:'马耳他', MU:'毛里求斯', MW:'马拉维',
  MX:'墨西哥', MY:'马来西亚', MZ:'莫桑比克', NA:'纳米比亚', NE:'尼日尔', NG:'尼日利亚',
  NI:'尼加拉瓜', NL:'荷兰', NO:'挪威', NP:'尼泊尔', NZ:'新西兰', OM:'阿曼', PA:'巴拿马',
  PE:'秘鲁', PG:'巴布亚新几内亚', PH:'菲律宾', PK:'巴基斯坦', PL:'波兰', PT:'葡萄牙',
  PW:'帕劳', PY:'巴拉圭', QA:'卡塔尔', RO:'罗马尼亚', RU:'俄罗斯', RW:'卢旺达',
  SA:'沙特阿拉伯', SB:'所罗门群岛', SC:'塞舌尔', SE:'瑞典', SG:'新加坡', SI:'斯洛文尼亚',
  SK:'斯洛伐克', SL:'塞拉利昂', SN:'塞内加尔', SR:'苏里南', ST:'圣多美和普林西比',
  SV:'萨尔瓦多', SZ:'斯威士兰', TC:'特克斯和凯科斯群岛', TD:'乍得', TG:'多哥',
  TH:'泰国', TJ:'塔吉克斯坦', TM:'土库曼斯坦', TN:'突尼斯', TR:'土耳其',
  TT:'特立尼达和多巴哥', TW:'中国台湾', TZ:'坦桑尼亚', UA:'乌克兰', UG:'乌干达',
  US:'美国', UY:'乌拉圭', UZ:'乌兹别克斯坦', VC:'圣文森特和格林纳丁斯',
  VE:'委内瑞拉', VG:'英属维尔京群岛', VN:'越南', YE:'也门', ZA:'南非', ZM:'赞比亚',
  ZW:'津巴布韦', PR:'波多黎各', SX:'荷属圣马丁',
};

// Artist locations can include any ISO country represented by Jamendo data.
const regionNames = new Intl.DisplayNames(['zh-Hans'], {type:'region'});
for (const code of artistCountryCodes) if (!COUNTRY_NAMES[code]) COUNTRY_NAMES[code] = regionNames.of(code);

const state = {
  lastKey: null,             // 上一次返回的歌曲 key（避免连续重复）
  refreshing: false,
};

let jamendoPool = []; // Jamendo 模式：全局歌曲池（完整 mp3）

// ---- 音频本地缓存 ----
let urlMap = {};     // id -> {url, type}; process-local by design
let warmQueue = [];  // 待预下载的 id 队列
let warmActive = 0;
const warmInFlight = new Map(); // id -> AbortController; release cancelled downloads promptly.
const playedAudioIds = new Set();
let warmReady = [];  // 已完整缓存的 id（可秒开，优先返回）
let warmPumpTimer = null;
const WARM_PUMP_DELAY_MS = 100;

function writeJsonAtomic(file, value) {
  const temporary = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { /* original error wins */ }
    throw error;
  }
}

function localUrl(id) {
  return '/audio/' + encodeURIComponent(id);
}

function audioCachePath(id) {
  return path.join(AUDIO_DIR, id + '.mp3');
}

function audioTempPath(id) {
  return audioCachePath(id) + '.tmp';
}

function listAudioFiles(includeTemp = true) {
  try {
    return fs.readdirSync(AUDIO_DIR)
      .filter((name) => includeTemp ? /\.mp3(?:\.tmp)?$/.test(name) : /\.mp3$/.test(name))
      .map((name) => {
        const file = path.join(AUDIO_DIR, name);
        try {
          const stat = fs.statSync(file);
          return { name, file, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function audioUsageBytes(exclude = new Set()) {
  return listAudioFiles(true)
    .filter((entry) => !exclude.has(entry.file))
    .reduce((total, entry) => total + Math.max(0, entry.size), 0);
}

function removeAudioFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[audio] cache cleanup failed: ' + error.message);
    return false;
  }
}

function isFreshAudioCache(id) {
  const file = audioCachePath(id);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return error.code === 'ENOENT' ? false : false;
  }
  if (Date.now() - stat.mtimeMs >= AUDIO_TTL_MS) {
    removeAudioFile(file);
    consumeWarm(id);
    return false;
  }
  return true;
}

function cleanupAudioCache() {
  const cutoff = Date.now() - AUDIO_TTL_MS;
  for (const entry of listAudioFiles(true)) {
    const isTemp = entry.name.endsWith('.mp3.tmp');
    const id = isTemp ? entry.name.slice(0, -8) : entry.name.slice(0, -4);
    // Never remove the one active warm write while it is still in flight.
    if (isTemp && warmInFlight.has(id)) continue;
    if (entry.mtimeMs <= cutoff) {
      removeAudioFile(entry.file);
      if (!isTemp) consumeWarm(id);
    }
  }
  evictOldest();
}

// 已缓存的歌被取走后，把它从"就绪"列表移除
function consumeWarm(id) {
  const i = warmReady.indexOf(id);
  if (i !== -1) warmReady.splice(i, 1);
}

function clearPlayedAudio(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  playedAudioIds.add(id);
  warmInFlight.get(id)?.abort();
  warmReady = warmReady.filter((readyId) => readyId !== id);
  warmQueue = warmQueue.filter((queuedId) => queuedId !== id);
  let removed = false;
  for (const file of [audioCachePath(id), audioTempPath(id)]) removed = removeAudioFile(file) || removed;
  return removed;
}

// 维持"始终有 WARM_TARGET 首歌在下载/已下载"的流水线
function topUpWarm() {
  if (MODE !== 'jamendo') return;
  expireStaleCandidates();
  cleanupAudioCache();
  if (jamendoPool.filter(s => !deliveredSongs.has(s.id)).length < POOL_TARGET && Date.now() >= discoveryRetryAt) {
    ensureJamendoPool(true).catch(error => {
      discoveryRetryAt = Date.now() + 15000;
      console.warn('[songs] random discovery: ' + error.message);
    });
  }
  const inFlight = warmReady.length + warmQueue.length + warmActive;
  const need = WARM_TARGET - inFlight;
  if (need > 0) {
    const candidates = jamendoPool.filter(
      (s) =>
        s.id &&
        !playedAudioIds.has(s.id) &&
        !deliveredSongs.has(s.id) &&
        !warmReady.includes(s.id) &&
        !warmQueue.includes(s.id) &&
        !warmInFlight.has(s.id) &&
        !isFreshAudioCache(s.id)
    );
    shuffle(candidates);
    for (const s of candidates.slice(0, need)) warmQueue.push(s.id);
    if (!warmPumpTimer) {
      warmPumpTimer = setTimeout(() => {
        warmPumpTimer = null;
        pumpWarm();
      }, WARM_PUMP_DELAY_MS);
      warmPumpTimer.unref();
    }
  }
  // 音频预缓存和国家/地区预缓存始终使用同一批“下一首”候选。
  prefetchUpcomingCountries();
}

async function pumpWarm() {
  while (warmActive < WARM_MAX && warmQueue.length) {
    const id = warmQueue.shift();
    const entry = urlMap[id];
    if (!entry || playedAudioIds.has(id)) continue;
    const controller = new AbortController();
    warmActive++;
    warmInFlight.set(id, controller);
    warmAudioTask(id, entry, controller).finally(() => {
      warmInFlight.delete(id);
      warmActive--;
      // A song can be handed to playback or released while its warm request
      // still occupies the only slot. Refill after that slot actually closes.
      // Ordinary upstream failures must not immediately retry the same song.
      if (deliveredSongs.has(id) || playedAudioIds.has(id)) {
        consumeWarm(id);
        topUpWarm();
      }
      pumpWarm();
    });
  }
}

async function warmAudioTask(id, entry, controller) {
  const tmp = audioTempPath(id);
  const target = audioCachePath(id);
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    removeAudioFile(tmp);
    const baseUsage = audioUsageBytes(new Set([tmp, target]));
    const res = await fetch(entry.url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      if (res.body) await res.body.cancel();
      return;
    }
    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isSafeInteger(declaredLength) && declaredLength > AUDIO_MAX_BYTES) {
      await res.body.cancel();
      return;
    }
    if (Number.isSafeInteger(declaredLength) && baseUsage + declaredLength > AUDIO_TOTAL_MAX_BYTES) {
      await res.body.cancel();
      return;
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > AUDIO_MAX_BYTES || baseUsage + received > AUDIO_TOTAL_MAX_BYTES) {
          callback(new Error('audio cache limit exceeded'));
          return;
        }
        callback(null, chunk);
      },
    });
    // pipeline handles backpressure, stream errors, and cancellation. The
    // limiter applies the same hard bounds when Content-Length is absent.
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(tmp), { signal: controller.signal });
    if (controller.signal.aborted || playedAudioIds.has(id)) {
      removeAudioFile(tmp);
      return;
    }
    const size = fs.statSync(tmp).size;
    if (size > AUDIO_MAX_BYTES || baseUsage + size > AUDIO_TOTAL_MAX_BYTES) {
      removeAudioFile(tmp);
      return;
    }
    fs.renameSync(tmp, target);
    // Use the application clock for TTL decisions as well as metadata. This
    // keeps expiry deterministic when the clock is supplied by an embedding
    // host or a test harness.
    const nowSeconds = Date.now() / 1000;
    try { fs.utimesSync(target, nowSeconds, nowSeconds); } catch { /* best effort */ }
    if (playedAudioIds.has(id)) {
      removeAudioFile(target);
      return;
    }
    if (!warmReady.includes(id)) warmReady.push(id);
    evictOldest();
    if (fs.existsSync(target)) {
      console.log('[audio] cached ' + id + ' (' + (fs.statSync(target).size / 1024).toFixed(0) + 'KB, ready=' + warmReady.length + ')');
    }
  } catch (e) {
    removeAudioFile(tmp);
  } finally {
    clearTimeout(timeout);
  }
}

function evictOldest() {
  const files = listAudioFiles(false).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, entry) => sum + Math.max(0, entry.size), 0);
  while (files.length > AUDIO_MAX || total > AUDIO_TOTAL_MAX_BYTES) {
    const old = files.shift();
    if (!old) break;
    if (removeAudioFile(old.file)) total -= Math.max(0, old.size);
    consumeWarm(old.name.slice(0, -4)); // 同步移除就绪列表
  }
}

const audioCleanupTimer = setInterval(() => {
  // Expire idle look-ahead metadata without starting another discovery or
  // warm request. A later user action can replenish the session pool.
  expireStaleCandidates();
  cleanupAudioCache();
}, AUDIO_CLEANUP_MS);
audioCleanupTimer.unref();

// 已缓存 → 支持 Range 的本地流；未缓存 → 从 Jamendo 转发（并后台补缓存）
async function serveAudio(req, res, id) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    json(res, 400, { error: 'invalid audio id' });
    return;
  }
  const entry = Object.prototype.hasOwnProperty.call(urlMap, id) ? urlMap[id] : null;
  if (!entry) {
    res.writeHead(404);
    res.end('unknown audio');
    return;
  }
  // 先打开再 stat/read，避免播放结束清理或缓存淘汰发生在检查与读取之间。
  let file;
  try {
    file = await fs.promises.open(audioCachePath(id), 'r');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (file) {
    try {
      const stat = await file.stat();
      if (Date.now() - stat.mtimeMs >= AUDIO_TTL_MS) {
        await file.close();
        file = null;
        removeAudioFile(audioCachePath(id));
        consumeWarm(id);
      }
      if (!file) {
        // The current track remains playable after its temporary cache expires;
        // fall through to a fresh Jamendo stream below.
      } else {
      const size = stat.size;
      // 只支持单段 bytes；其他单位和多段请求可按 HTTP 语义返回完整表示。
      const range = req.method === 'GET' && req.headers.range;
      const singleRange = range && range.startsWith('bytes=') && !range.includes(',');
      let start = 0;
      let end = size - 1;
      if (singleRange) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        const first = m && m[1] ? Number(m[1]) : null;
        const last = m && m[2] ? Number(m[2]) : null;
        start = first === null ? Math.max(0, size - last) : first;
        end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
        if (!m || (first === null && !last) ||
            (first !== null && !Number.isSafeInteger(first)) ||
            (last !== null && !Number.isSafeInteger(last)) ||
            start >= size || end < start) {
          res.writeHead(416, {
            'Content-Range': 'bytes */' + size,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': entry.type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Content-Length': size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
      }
      if (req.method === 'HEAD' || size === 0) res.end();
      else await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
      }
    } finally {
      if (file) await file.close();
    }
    if (file === null) {
      // Expired cache: stream the current track online below.
    } else {
      return;
    }
  }
  // Prioritize the browser stream over downloading the same track a second time.
  // Upcoming tracks still use the warm pipeline; current playback streams directly.
  if (req.method === 'GET') {
    warmQueue = warmQueue.filter(queuedId => queuedId !== id);
    warmInFlight.get(id)?.abort();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  try {
    const headers = { 'User-Agent': UA, 'Accept-Encoding': 'identity' };
    if (req.method === 'GET' && req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(entry.url, {
      method: req.method,
      headers,
      signal: controller.signal,
    });
    if (!upstream.ok && upstream.status !== 416) {
      if (upstream.body) await upstream.body.cancel();
      res.writeHead(502);
      res.end('upstream failed');
      return;
    }
    const responseHeaders = {
      'Content-Type': entry.type,
      'Cache-Control': 'no-store',
    };
    for (const name of ['content-range', 'content-length', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (req.method === 'HEAD' || !upstream.body) res.end();
    else await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (!res.destroyed) {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', cancel);
  }
}

class FetchError extends Error {
  constructor(msg, definitive) {
    super(msg);
    this.definitive = !!definitive;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Jamendo：完整 mp3 全局歌曲池 ----
// tracks 接口不含地区；通过独立的 artists/locations 接口补充，
// 在全目录随机位置抽样，候选用完即补充，不以热门程度或国家资料完整度排序。
const POOL_TARGET = 6; // Only a small rotating look-ahead buffer.
const DISCOVERY_BOUNDS_FILE = path.join(DATA_ROOT, 'catalog-bounds.json');
let cachedBounds;
try { cachedBounds = JSON.parse(fs.readFileSync(DISCOVERY_BOUNDS_FILE, 'utf8')); } catch { /* first startup */ }
const discovery = createDiscovery({request: fetchDiscoveryPage, cachedBounds,
  saveBounds: value => writeJsonAtomic(DISCOVERY_BOUNDS_FILE, value),
  acceptTrack: normalizeJamendoTrack,
});
const deliveredSongs = new Set();
let discoveryRetryAt = 0;
let poolRequest = null;
const poolWaiters = new Set();

async function fetchDiscoveryPage(options) {
  const params = new URLSearchParams({
    client_id: JAMENDO_ID,
    format: 'json',
    limit: options.limit,
    ...(options.order ? {order: options.order} : {}),
    ...(options.id ? {id: options.id} : {}),
    type: 'single+albumtrack',
    audioformat: 'mp32',
  });
  const url = 'https://api.jamendo.com/v3.0/tracks/?' + params.toString();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
      compress: true,
    });
  } catch (e) {
    throw new FetchError((e.cause && e.cause.code) || e.name, false);
  }
  if (res.status === 400 || res.status === 404) {
    throw new FetchError('Jamendo HTTP ' + res.status, true);
  }
  if (!res.ok) {
    throw new FetchError('Jamendo HTTP ' + res.status, false);
  }
  let j;
  try {
    j = await res.json();
  } catch (e) {
    throw new FetchError('bad response body', false);
  }
  if (j && j.headers && j.headers.status === 'failed') {
    console.error('[songs] Jamendo API 错误: ' + (j.headers.error_message || 'unknown'));
    throw new FetchError('Jamendo API failed', true); // key 无效等情况 → 永久无效，避免反复请求
  }
  const results = (j && j.results) || [];
  // Jamendo uses "success", including an empty final page. Keep compatibility
  // with older cached/test responses that use "OK".
  if (!results.length && !(j && j.headers && ['success', 'OK'].includes(j.headers.status))) {
    throw new FetchError('unexpected response body', false);
  }
  return j;
}

function ensureJamendoPool(force = false) {
  if (jamendoPool.some(s => !deliveredSongs.has(s.id)) && !force) {
    prefetchUpcomingCountries();
    return Promise.resolve(jamendoPool);
  }
  if (!poolRequest) poolRequest = fetchJamendoPool().finally(() => { poolRequest = null; });
  if (force) return poolRequest;
  let wake;
  const available = new Promise(resolve => { wake = resolve; poolWaiters.add(wake); });
  return Promise.race([poolRequest, available]).finally(() => poolWaiters.delete(wake));
}

async function fetchJamendoPool() {
  const waiting = jamendoPool.filter(s => !deliveredSongs.has(s.id));
  if (waiting.length >= POOL_TARGET) return waiting;
  return discovery.sample(POOL_TARGET - waiting.length,
    new Set([...deliveredSongs, ...jamendoPool.map(s => s.id)]), installJamendoTracks);
}

function removeSessionSongArtifacts(id) {
  warmInFlight.get(id)?.abort();
  warmQueue = warmQueue.filter((queuedId) => queuedId !== id);
  warmReady = warmReady.filter((readyId) => readyId !== id);
  removeAudioFile(audioCachePath(id));
  removeAudioFile(audioTempPath(id));
}

function pruneUrlMap() {
  const liveIds = new Set(jamendoPool.map((song) => String(song.id)));
  for (const id of Object.keys(urlMap)) {
    if (!liveIds.has(id)) delete urlMap[id];
  }
}

// Metadata for an unused look-ahead candidate expires with the temporary
// audio budget. The delivered/current history remains available for a paused
// player and can refetch its stream if its local file has expired.
function expireStaleCandidates() {
  const cutoff = Date.now() - AUDIO_TTL_MS;
  let changed = false;
  jamendoPool = jamendoPool.filter((song) => {
    if (deliveredSongs.has(song.id) || !Number.isFinite(song.fetchedAt) || song.fetchedAt > cutoff) {
      return true;
    }
    removeSessionSongArtifacts(song.id);
    delete urlMap[song.id];
    changed = true;
    return false;
  });
  if (changed) pruneUrlMap();
  return changed;
}

function installJamendoTracks(results) {
  const seen = new Set();
  const all = [];
  const freshUrls = {};
  for (const t of results) {
    if (!t || !t.id || seen.has(String(t.id))) continue;
    seen.add(String(t.id));
    const id = String(t.id);
    const song = t.license && t.sourceUrl ? {...t, fetchedAt: Date.now()} : normalizeJamendoTrack(t);
    if (!song) continue;
    all.push(song);
    freshUrls[id] = {url:song.streamUrl,type:'audio/mpeg'};
  }
  if (!all.length) throw new FetchError('Jamendo returned no playable tracks; previous pool retained', false);
  // Only the next few candidates and short metadata history are retained.
  const pending = jamendoPool.filter(s => !deliveredSongs.has(s.id));
  const history = jamendoPool.filter(s => deliveredSongs.has(s.id)).slice(-16);
  const next = [...history, ...pending, ...all];
  jamendoPool = next;
  Object.assign(urlMap, freshUrls);
  pruneUrlMap();
  console.log('[songs] Jamendo pool: ' + all.length + ' new random tracks');
  prefetchCountryBatch(all);
  topUpWarm();
  prefetchUpcomingCountries();
  for (const wake of poolWaiters) wake(jamendoPool);
  return all;
}

function pickJamendoSong() {
  if (!jamendoPool.length) return null;
  // 优先返回已缓存（秒开）的歌曲；就绪列表为空时才退回随机
  const readySongs = warmReady
    .map((id) => jamendoPool.find((s) => s.id === id))
    .filter(Boolean);
  const unplayed = jamendoPool.filter(s => !deliveredSongs.has(s.id));
  const ready = readySongs.filter(s => !deliveredSongs.has(s.id));
  const candidates = ready.length ? ready : unplayed;
  if (!candidates.length) return null;
  for (let i = 0; i < 10; i++) {
    const s = candidates[randomIndex(candidates.length)];
    const key = s.title + '|' + s.artist;
    if (key !== state.lastKey) {
      state.lastKey = key;
      playedAudioIds.delete(s.id);
      deliveredSongs.add(s.id);
      if (deliveredSongs.size > 1000) deliveredSongs.delete(deliveredSongs.values().next().value);
      return s;
    }
  }
  const s = candidates[randomIndex(candidates.length)];
  if (s) { playedAudioIds.delete(s.id); deliveredSongs.add(s.id); }
  return s;
}

// ---------------------------------------------------------------- 随机选歌
function randomIndex(n) {
  return (Math.random() * n) | 0;
}

async function pickSong(cancelled = () => false) {
  if (MODE !== 'jamendo') return null;
  expireStaleCandidates();
  if (!jamendoPool.some(s => !deliveredSongs.has(s.id))) await ensureJamendoPool();
  if (cancelled()) return null;
  return pickJamendoSong();
}

// ---------------------------------------------------------------- 后台预取
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ================================================================
// 艺术家国籍解析（让像素地球高亮"歌曲来自哪个国家"）
// 使用带来源的核实资料、Jamendo 声明地区及 MusicBrainz；未知结果一天后可重试。
// ================================================================
const ARTIST_COUNTRY_FILE = path.join(DATA_ROOT, 'artist-countries.json');
let artistCountry = {};   // artistName -> {code, country, source, ts}
let countryQueue = [];    // 后台回填队列
const countryQueued = new Set();
let countryPumping = false;
const inflightCountry = {}; // artistName -> Promise（去重）
const mbRef = { v: 0 };
const jamendoCountryRef = { v: 0 };
const mbAreaCountryCache = new Map(); // area id -> {code, definitive}
const countryEvidence = [verifiedCountries, jamendoCountrySeed].map(records =>
  new Map(Object.entries(records).map(([name, rec]) => [normalizeArtistName(name), rec]))
);

function normalizeArtistName(name) {
  const decoded = String(name || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  return decoded.trim().replace(/\s+/g, ' ');
}

function evidenceCountryForSong(song) {
  if (!song) return null;
  const key = normalizeArtistName(song.artist);
  // Reviewed evidence survives runtime-cache cleanup. Scope it to the catalog
  // identity that was checked, so an unrelated namesake cannot inherit it.
  for (const [records, source] of [[countryEvidence[0], 'verified'], [countryEvidence[1], 'jamendo']]) {
    const rec = records.get(key);
    if (rec && COUNTRY_NAMES[rec.code] && rec.sourceUrl &&
      ((rec.trackIds || []).includes(String(song.id)) || (rec.artistId && String(song.artistId) === rec.artistId))) {
      return {...rec, country: COUNTRY_NAMES[rec.code], source, resolverVersion: COUNTRY_RESOLVER_VERSION, ts: Date.now()};
    }
  }
  return null;
}

function cachedArtistCountry(name) {
  const raw = String(name || '').trim();
  const key = normalizeArtistName(raw);
  const songs = jamendoPool.filter(song => normalizeArtistName(song.artist) === key);
  const evidence = songs.map(evidenceCountryForSong);
  if (evidence.length && evidence.every(rec => rec && rec.code === evidence[0].code)) return evidence[0];
  const cached = artistCountry[key] || artistCountry[raw] || null;
  const ids = [...new Set(songs.map(song => song.artistId).filter(Boolean))];
  if (ids.length && (!cached || ids.length !== 1 || cached.artistId !== ids[0])) return null;
  return cached;
}

function isFreshCountryRecord(rec) {
  return Boolean(
    rec &&
    rec.resolverVersion === COUNTRY_RESOLVER_VERSION &&
    rec.ts &&
    Date.now() - rec.ts < (rec.source === 'none' ? 86400000 : COUNTRY_CACHE_TTL)
  );
}

function isTrustedCountryRecord(rec) {
  return Boolean(
    rec &&
    TRUSTED_COUNTRY_SOURCES.has(rec.source) &&
    rec.resolverVersion === COUNTRY_RESOLVER_VERSION
  );
}

function isFreshCountryAnnotation(song) {
  const ts = Number(song && song.countryResolvedAt);
  return Boolean(
    song &&
    song.countryResolverVersion === COUNTRY_RESOLVER_VERSION &&
    Number.isFinite(ts) &&
    ts > 0 &&
    Date.now() - ts < COUNTRY_CACHE_TTL
  );
}

function countryRecordForSong(song) {
  const evidence = evidenceCountryForSong(song);
  if (evidence) return evidence;
  const cached = cachedArtistCountry(song && song.artist);
  if (isFreshCountryRecord(cached) && cached.code && isTrustedCountryRecord(cached)) {
    return cached;
  }
  const code = String((song && song.countrycode) || '').toUpperCase();
  // 旧版池文件只有 countrycode/country，没有来源和时间戳，不能继续信任。
  if (
    song &&
    TRUSTED_COUNTRY_SOURCES.has(song.countrySource) &&
    isFreshCountryAnnotation(song) &&
    /^[A-Z]{2}$/.test(code) &&
    COUNTRY_NAMES[code]
  ) {
    return {
      code,
      country: song.country || COUNTRY_NAMES[code],
      source: song.countrySource,
      sourceUrl: song.countrySourceUrl || '',
      ts: song.countryResolvedAt,
    };
  }
  return null;
}

function annotatePoolCountry(artist, rec) {
  if (MODE !== 'jamendo') return;
  const key = normalizeArtistName(artist);
  let changed = false;
  for (const song of jamendoPool) {
    if (normalizeArtistName(song.artist) !== key) continue;
    if (rec && rec.artistId && song.artistId && rec.artistId !== song.artistId) continue;
    if (!rec || !rec.code || !isTrustedCountryRecord(rec)) {
      if (
        song.countrycode ||
        song.country !== '未知地区' ||
        song.countrySource ||
        song.countryResolvedAt ||
        song.countryResolverVersion
      ) {
        song.countrycode = '';
      song.country = '未知地区';
      delete song.countrySource;
      delete song.countrySourceUrl;
      delete song.countryResolvedAt;
      delete song.countryResolverVersion;
      changed = true;
      }
      continue;
    }
    if (
      song.countrycode !== rec.code ||
      song.country !== rec.country ||
      song.countrySource !== rec.source ||
      song.countryResolvedAt !== rec.ts
    ) {
      song.countrycode = rec.code;
      song.country = rec.country || COUNTRY_NAMES[rec.code] || '未知地区';
      song.countrySource = rec.source;
      song.countrySourceUrl = rec.sourceUrl || '';
      song.countryResolvedAt = rec.ts;
      song.countryResolverVersion = COUNTRY_RESOLVER_VERSION;
      changed = true;
    }
  }
}

function loadArtistCountries() {
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(ARTIST_COUNTRY_FILE, 'utf8')) || {};
  } catch (e) {
    loaded = {};
  }
  // Startup cleanup intentionally leaves this evidence file byte-for-byte
  // intact. Invalid or stale records are ignored by the freshness checks when
  // used, but are not silently rewritten as part of a playback-cache purge.
  artistCountry = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
}

function saveArtistCountries() {
  try {
    fs.writeFileSync(ARTIST_COUNTRY_FILE, JSON.stringify(artistCountry));
  } catch (e) { /* ignore */ }
}

async function throttle(ref, minGap) {
  const now = Date.now();
  const wait = Math.max(0, minGap - (now - ref.v));
  ref.v = now + wait;
  if (wait) await sleep(wait);
}

async function musicBrainzJson(url) {
  // MusicBrainz 偶尔会返回 503；临时故障不能被写成“无国家”，否则会被
  // 负缓存挡住数天。只对可重试的响应和网络错误做少量退避重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle(mbRef, 1100); // MusicBrainz 限速 1 req/s
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { json: await res.json(), definitive: true };
      if (![408, 425, 429, 500, 502, 503, 504].includes(res.status)) {
        return { json: null, definitive: true };
      }
    } catch (e) {
      // 网络抖动、TLS 临时失败或超时：不要把它当成艺术家没有国家。
    }
  }
  return { json: null, definitive: false };
}

async function mbAreaTreeLookup(areaId, seen, depth) {
  if (!areaId || seen.has(areaId) || depth > 4) {
    return { code: null, definitive: true };
  }
  const cached = mbAreaCountryCache.get(areaId);
  if (cached) return cached;
  seen.add(areaId);
  const url = 'https://musicbrainz.org/ws/2/area/' +
    encodeURIComponent(areaId) + '?inc=area-rels&fmt=json';
  const result = await musicBrainzJson(url);
  if (!result.definitive) return { code: null, definitive: false };

  const parentAreas = (result.json && result.json.relations || [])
    .filter((relation) =>
      relation && relation.type === 'part of' &&
      relation.direction === 'backward' && relation.area
    )
    .map((relation) => relation.area);
  const directCodes = parentAreas
    .map((area) => extractMusicBrainzCountryCode({ area }, COUNTRY_NAMES))
    .filter(Boolean);
  const directUnique = [...new Set(directCodes)];
  if (directUnique.length === 1) {
    const resolved = { code: directUnique[0], definitive: true };
    mbAreaCountryCache.set(areaId, resolved);
    return resolved;
  }
  if (directUnique.length > 1) {
    const ambiguous = { code: null, definitive: true };
    mbAreaCountryCache.set(areaId, ambiguous);
    return ambiguous;
  }

  let transientFailure = false;
  const parentCodes = [];
  for (const parent of parentAreas) {
    if (!parent.id) continue;
    const nested = await mbAreaTreeLookup(parent.id, seen, depth + 1);
    if (!nested.definitive) transientFailure = true;
    if (nested.code) parentCodes.push(nested.code);
  }
  const unique = [...new Set(parentCodes)];
  const resolved = {
    code: unique.length === 1 ? unique[0] : null,
    definitive: !transientFailure,
  };
  if (resolved.definitive) mbAreaCountryCache.set(areaId, resolved);
  return resolved;
}

async function mbAreaLookup(artist) {
  // begin-area 更接近艺术家的出生/来源地；如果没有结果，再看当前 area。
  const areas = [artist && artist['begin-area'], artist && artist.area]
    .filter((area) => area && area.id);
  let transientFailure = false;
  for (const area of areas) {
    const result = await mbAreaTreeLookup(area.id, new Set(), 0);
    if (!result.definitive) transientFailure = true;
    if (result.code) return { code: result.code, definitive: true };
  }
  // 多个国家关系不确定时仍保持未知；资料源临时不可用时则下次重试。
  return { code: null, definitive: !transientFailure };
}

async function mbLookup(name) {
  const url = 'https://musicbrainz.org/ws/2/artist/?query=artist:%22' +
    encodeURIComponent(name) + '%22&inc=area-rels&fmt=json&limit=8';
  const result = await musicBrainzJson(url);
  if (!result.definitive) return { code: null, definitive: false };
  const artists = result.json && result.json.artists || [];
  const iso = selectMusicBrainzCountryCode(artists, name, COUNTRY_NAMES);
  // 只接受标准 ISO 码（在中文国家名表里查得到），过滤 MusicBrainz 的非标码（如 XW）
  if (iso) return { code: iso, definitive: true };

  // 艺术家只有城市/地区而没有国家码时，沿 MusicBrainz 的 area 关系查父级国家。
  // 仅对唯一精确匹配执行，避免把同名艺术家的出生地混到一起。
  const artist = selectMusicBrainzArtist(artists, name);
  if (!artist) return { code: null, definitive: true };
  return mbAreaLookup(artist);
}

// 解析单个艺术家国籍（去重 + 缓存 + 30 天有效期）
function resolveArtistCountry(name) {
  const key = normalizeArtistName(name);
  if (!key) return Promise.resolve(null);
  const matchingIds = new Set(jamendoPool.filter(s => normalizeArtistName(s.artist) === key).map(s => s.artistId).filter(Boolean));
  if (matchingIds.size > 1) return Promise.resolve(null);
  const cached = cachedArtistCountry(key);
  if (isFreshCountryRecord(cached)) {
    return Promise.resolve(isTrustedCountryRecord(cached) && cached.code ? cached : null);
  }
  if (inflightCountry[key]) return inflightCountry[key];
  const p = (async () => {
    const artistIds = [...new Set(jamendoPool.filter(s => normalizeArtistName(s.artist) === key).map(s => s.artistId).filter(Boolean))];
    if (artistIds.length > 1) return null;
    const jamendo = await lookupJamendoCountry(key, artistIds.length === 1 ? artistIds[0] : null, {
      clientId: JAMENDO_ID, countries: COUNTRY_NAMES,
      fetchJson: async url => {
        await throttle(jamendoCountryRef, 1200);
        const res = await fetch(url, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(REQ_TIMEOUT)});
        if (!res.ok) throw new Error('Jamendo location HTTP ' + res.status);
        return res.json();
      },
    });
    return finishArtistCountry(key, artistIds, jamendo);
  })().finally(() => { delete inflightCountry[key]; });
  inflightCountry[key] = p;
  return p;
}

async function finishArtistCountry(key, artistIds, jamendo) {
  const lookup = jamendo.code ? jamendo : await mbLookup(key);
  // 暂时无法访问资料源：不落盘、不清除旧的可信标注，让后续轮询或下次播放重试。
  if (!lookup.definitive || (!lookup.code && !jamendo.definitive)) return null;
  const code = lookup.code;
  const source = lookup.source || 'mb';
  const rec = {
    code: code || null,
    country: code ? (COUNTRY_NAMES[code] || code) : null,
    source: code ? source : 'none',
    artistId: artistIds.length === 1 ? artistIds[0] : '',
    sourceUrl: lookup.sourceUrl || (code ? 'https://musicbrainz.org/search?type=artist&query=' + encodeURIComponent(key) : ''),
    resolverVersion: COUNTRY_RESOLVER_VERSION,
    ts: Date.now(),
  };
  artistCountry[key] = rec;
  saveArtistCountries();
  annotatePoolCountry(key, rec);
  return code ? rec : null;
}

let pendingCountryBatch = null;
function prefetchCountryBatch(songs) {
  const pending = songs.filter(s => s.artistId && !countryRecordForSong(s) &&
    !isFreshCountryRecord(cachedArtistCountry(s.artist)) && !inflightCountry[normalizeArtistName(s.artist)]);
  if (!pending.length) return;
  // Briefly coalesce nearby discoveries, registering inflight tasks immediately
  // so the current track and background queue join the same location request.
  if (!pendingCountryBatch) {
    const batch = { ids: new Set(), resolve: null, promise: null };
    batch.promise = new Promise(resolve => { batch.resolve = resolve; });
    pendingCountryBatch = batch;
    setTimeout(async () => {
      pendingCountryBatch = null;
      if (!batch.ids.size) { batch.resolve({ artists: [], definitive: true }); return; }
      let result = { artists: [], definitive: false };
      try {
        const params = new URLSearchParams({client_id:JAMENDO_ID,format:'json',limit:'200',id:[...batch.ids].join('+')});
        const res = await fetch('https://api.jamendo.com/v3.0/artists/locations/?' + params, {
          headers:{'User-Agent':UA}, signal:AbortSignal.timeout(REQ_TIMEOUT),
        });
        if (res.ok) {
          const body = await res.json();
          if (body.headers?.status === 'success' && Array.isArray(body.results)) {
            result = { artists: body.results, definitive: true };
          }
        } else if (res.body) await res.body.cancel();
      } catch { /* A failed batch must remain retryable. */ }
      batch.resolve(result);
    }, 40);
  }
  const batch = pendingCountryBatch;
  for (const song of pending) {
    const key = normalizeArtistName(song.artist);
    if (!key || inflightCountry[key]) continue;
    const namesakes = new Set(jamendoPool.filter(s => normalizeArtistName(s.artist) === key).map(s => s.artistId).filter(Boolean));
    if (namesakes.size !== 1) continue;
    batch.ids.add(song.artistId);
    const task = batch.promise.then(({artists, definitive}) => {
      const location = selectLocation(artists, key, song.artistId, COUNTRY_NAMES);
      // Reuse the authoritative empty result when falling back to MusicBrainz;
      // repeating artists/locations only adds latency and consumes an API request.
      return finishArtistCountry(key, [song.artistId], { ...(location || { code: null }), definitive });
    }).catch(() => null);
    inflightCountry[key] = task.finally(() => { delete inflightCountry[key]; });
  }
}

function queueCountryArtist(name, priority) {
  if (MODE !== 'jamendo') return;
  const key = normalizeArtistName(name);
  if (!key) return;
  const prepared = jamendoPool.find((song) =>
    normalizeArtistName(song.artist) === key && countryRecordForSong(song)
  );
  if (prepared) return;
  const cached = cachedArtistCountry(key);
  if (isFreshCountryRecord(cached)) return;
  if (cached && cached.source === 'none' && cached.ts && Date.now() - cached.ts < COUNTRY_NONE_TTL) return;
  if (inflightCountry[key] || countryQueued.has(key)) return;
  countryQueued.add(key);
  if (priority) countryQueue.unshift(key);
  else countryQueue.push(key);
  pumpCountryQueue();
}

function prefetchUpcomingCountries() {
  if (MODE !== 'jamendo' || !jamendoPool.length) return;
  const preferredIds = [...warmReady, ...warmQueue];
  const preferred = [];
  const used = new Set();
  for (const id of preferredIds) {
    const song = jamendoPool.find((s) => s.id === id);
    if (song && !used.has(song.id)) {
      used.add(song.id);
      preferred.push(song);
    }
  }
  const remaining = jamendoPool.filter((song) => !used.has(song.id) && !deliveredSongs.has(song.id));
  shuffle(remaining);
  const upcoming = preferred.concat(remaining.slice(0, COUNTRY_PREFETCH_TARGET));
  prefetchCountryBatch(upcoming);
  for (const song of upcoming) {
    queueCountryArtist(song.artist, true);
  }
}

// 后台回填：把歌曲池里所有未解析的艺术家都查一遍
function backfillArtistCountries() {
  if (MODE !== 'jamendo') return;
  const seen = new Set();
  for (const s of jamendoPool) {
    const k = normalizeArtistName(s.artist);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    queueCountryArtist(k, false);
  }
}

async function pumpCountryQueue() {
  if (countryPumping) return;
  countryPumping = true;
  let done = 0;
  const total = countryQueue.length;
  console.log('[country] backfill starts, ' + total + ' artists to resolve…');
  while (countryQueue.length) {
    const key = countryQueue.shift();
    try {
      await resolveArtistCountry(key);
      done++;
      if (done % 25 === 0) {
        console.log('[country] resolved ' + done + '/' + total +
          ' (known=' + Object.keys(artistCountry).filter((k) => artistCountry[k].code).length + ')');
      }
    } catch (e) { /* ignore */ }
    countryQueued.delete(key);
  }
  countryPumping = false;
  const known = Object.keys(artistCountry).filter((k) => artistCountry[k].code).length;
  console.log('[country] backfill done: ' + done + ' artists checked, ' + known + ' countries known');
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, code, obj) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const p = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // 一律 no-cache：确保前端改动刷新即可见（配合 index.html 里的 ?v= 版本号）
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function handleApi(req, res, pathname, urlObj) {
  if (pathname === '/api/audio/played') {
    if (MODE !== 'jamendo') {
      res.writeHead(204);
      res.end();
      return;
    }
    const id = (urlObj.searchParams.get('id') || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { json(res, 400, { error: 'invalid audio id' }); return; }
    const removed = clearPlayedAudio(id);
    topUpWarm();
    json(res, 200, { ok: true, id, removed });
    return;
  }
  if (pathname === '/api/client-session') {
    if (!BROWSER_LIFECYCLE) { json(res, 404, { error: 'browser lifecycle disabled' }); return; }
    const id = (urlObj.searchParams.get('id') || '').trim();
    const state = (urlObj.searchParams.get('state') || 'heartbeat').toLowerCase();
    if (!isValidBrowserSessionId(id)) { json(res, 400, { error: 'invalid session' }); return; }
    updateBrowserSession(id, state === 'disconnect' ? 'disconnect' : 'heartbeat');
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === '/api/song') {
    if (MODE === 'setup-required') {
      json(res, 503, {
        code: 'JAMENDO_SETUP_REQUIRED',
        error: '请先配置 Jamendo client_id',
      });
      return;
    }
    if (urlObj.searchParams.has('country')) {
      json(res, 400, {
        code: 'COUNTRY_FILTER_UNSUPPORTED',
        error: 'Jamendo 模式不支持按国家筛选',
      });
      return;
    }
    const respond = async (s) => {
      if (res.destroyed) return;
      const out = Object.assign({}, s);
      // Jamendo 模式：走本地 /audio 代理（已缓存则秒开，未缓存则转发并后台预下载）
      if (MODE === 'jamendo' && s.id) {
        out.streamUrl = localUrl(s.id);
        consumeWarm(s.id); // 这首歌被取走，从就绪列表移除
        topUpWarm();       // 立刻补一首新的进预下载流水线
      }
      // Country lookup never delays playable song metadata. Return any result
      // already prefetched; /api/country delivers the remaining work independently.
      if (MODE === 'jamendo' && s.artist) {
        let rec = countryRecordForSong(s);
        if (!rec) {
          resolveArtistCountry(s.artist).catch(() => {});
        }
        if (rec) {
          out.countrycode = rec.code;
          out.country = rec.country || COUNTRY_NAMES[rec.code] || out.country;
          out.countryStatus = 'resolved';
          out.countrySource = rec.source;
          out.countrySourceUrl = rec.sourceUrl || '';
        } else {
          // resolveArtistCountry 可能仍在飞行中；队列会自动去重，不会重复请求。
          queueCountryArtist(s.artist, true);
          const latest = cachedArtistCountry(s.artist);
          const definitiveNone =
            isFreshCountryRecord(latest) && latest.source === 'none';
          out.countryStatus = definitiveNone ? 'none' : 'resolving';
        }
      }
      json(res, 200, out);
    };
    pickSong(() => res.destroyed).then((s) => {
      if (!s) { json(res, 503, { error: '歌曲库尚未就绪，请稍后重试' }); return; }
      respond(s).catch(() => json(res, 500, { error: 'fetch failed' }));
    }).catch(() => json(res, 503, { error: '歌曲库尚未就绪，请稍后重试' }));
    return;
  }
  if (pathname === '/api/country') {
    // 返回歌曲所属艺术家的国家（必要时现场联网解析一次）
    const id = (urlObj.searchParams.get('id') || '').trim();
    const song = jamendoPool.find((s) => s.id === id);
    if (!song) { json(res, 404, { error: 'unknown song' }); return; }
    const cached = countryRecordForSong(song);
    const result = cached ? Promise.resolve(cached) : resolveArtistCountry(song.artist);
    result.then((rec) => {
      const latest = cachedArtistCountry(song.artist);
      const definitiveNone = isFreshCountryRecord(latest) && latest.source === 'none';
      json(res, 200, {
        id: song.id,
        artist: song.artist,
        countrycode: rec && rec.code ? rec.code : '',
        country: rec && rec.country ? rec.country : '',
        source: rec && rec.source || '',
        sourceUrl: rec && rec.sourceUrl || '',
        status: rec && rec.code ? 'resolved' : definitiveNone ? 'none' : 'resolving',
      });
    }).catch(() => json(res, 200, { id: song.id, countrycode: '', country: '', status: 'error' }));
    return;
  }
  if (pathname === '/api/countries') {
    json(res, 200, []);
    return;
  }
  if (pathname === '/api/info') {
    json(res, 200, {
      mode: MODE,
      configured: Boolean(JAMENDO_ID),
      countries: 0,
      total: COUNTRY_CODES.length,
      songs: jamendoPool.length,
      invalid: 0,
      empty: 0,
      refreshedAt: new Date().toISOString(),
    });
    return;
  }
  json(res, 404, { error: 'unknown api' });
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  let urlObj = null;
  try {
    urlObj = new URL(req.url, 'http://localhost');
    pathname = urlObj.pathname;
  } catch (e) {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, urlObj);
  } else if (pathname.startsWith('/audio/')) {
    let id;
    try {
      id = decodeURIComponent(pathname.slice('/audio/'.length));
    } catch (error) {
      json(res, 400, { error: 'invalid audio path' });
      return;
    }
    serveAudio(req, res, id).catch(() => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  } else {
    serveStatic(req, res, pathname);
  }
});

// ---------------------------------------------------------------- 启动
(async () => {
  if (MODE === 'jamendo') {
    console.log('[songs] MODE: Jamendo 全曲播放（已配置 client_id）');
  } else {
    console.log('[songs] MODE: setup-required（未配置 Jamendo client_id）');
    console.log('[songs] 请在 data/config.json 或 JAMENDO_CLIENT_ID 中配置 client_id');
  }
  loadArtistCountries();

  if (MODE === 'jamendo') {
    // Song metadata and remote URLs are session-only. Every session starts
    // with a fresh discovery and an empty warm list.
    ensureJamendoPool().then(() => {
      topUpWarm();
      prefetchUpcomingCountries();
      backfillArtistCountries();
    }).catch((e) =>
      console.error('[songs] pool fetch failed: ' + e.message));
  }

  setInterval(async () => {
    if (MODE !== 'jamendo' || state.refreshing) return;
    console.log('[songs] refreshing Jamendo pool…');
    state.refreshing = true;
    try {
      await ensureJamendoPool(true);
      topUpWarm();
      prefetchUpcomingCountries();
      backfillArtistCountries();
    } catch (e) {
      console.error('[songs] pool refresh failed: ' + e.message);
    } finally {
      state.refreshing = false;
    }
  }, REFRESH_MS);

  server.listen(PORT, HOST, () => {
    console.log('[server] World Vinyl running at http://' + HOST + ':' + PORT);
    console.log('[server] press R on the page to skip to a random song from a random country');
  });
})();
