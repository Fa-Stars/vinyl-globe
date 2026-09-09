'use strict';
// 世界唱片机 —— 后端
//  数据源（双模式）：
//    ① Jamendo（推荐，全曲播放）：正版免费 CC 音乐，持续从在线完整目录随机发现歌曲。
//       需要免费 client_id：https://devportal.jamendo.com 注册后创建应用即可获取，
//       填入 data/config.json 的 jamendoClientId 字段，或设环境变量 JAMENDO_CLIENT_ID。
//    ② iTunes RSS（兜底，30 秒试听）：各国热门歌曲榜，无需 key。
//  爬取：按国家惰性抓取 + 磁盘缓存 + 后台预取，保证"下一个请求秒回"
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
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { clearRuntimeCache } = require('../runtime-cache');
const { lookupJamendoCountry, selectLocation, countryCodes: artistCountryCodes } = require('./jamendo-country');
const { createDiscovery } = require('./random-discovery');
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
const MODE = JAMENDO_ID ? 'jamendo' : 'itunes';
const SONGS_DIR = path.join(DATA_ROOT, MODE === 'jamendo' ? 'jamendo' : 'songs'); // data/jamendo 或 data/songs
const INVALID_FILE = path.join(SONGS_DIR, '_invalid.json');
const POOL_FILE = path.join(SONGS_DIR, 'pool.json'); // Jamendo 全局歌曲池缓存
const AUDIO_DIR = path.join(DATA_ROOT, 'audio');   // 音频本地缓存（预下载）
const URL_MAP_FILE = path.join(AUDIO_DIR, '_urls.json'); // id -> 远程 URL 映射
const AUDIO_MAX = 60;    // 音频缓存文件数上限（约 60 × 4MB ≈ 240MB）
const WARM_MAX = 3;      // 同时预下载的并发上限
const WARM_TARGET = 4;  // 随时保持 4 首歌处于"已下载 / 下载中"，保证换歌流畅
const WARM_READY_WAIT_MS = 5000; // 缓存刚启动时，最多等一首就绪再返回歌曲
const COUNTRY_CACHE_TTL = 30 * 86400 * 1000;
const COUNTRY_NONE_TTL = 86400 * 1000;
const COUNTRY_PREFETCH_TARGET = 16; // 与音频预缓存同一批，提前准备国家/地区
const COUNTRY_LOOKUP_WAIT_MS = 1400; // 当前歌曲优先解析，最多不阻塞换歌多久

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

// ---------------------------------------------------------------- 国家列表
// Apple iTunes 商店支持的国家码（ISO 3166-1 alpha-2），附中文名
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

// Artist locations are not limited to countries with an iTunes storefront.
const regionNames = new Intl.DisplayNames(['zh-Hans'], {type:'region'});
for (const code of artistCountryCodes) if (!COUNTRY_NAMES[code]) COUNTRY_NAMES[code] = regionNames.of(code);

const state = {
  songsByCountry: new Map(), // code -> song[]（仅 iTunes 模式）
  invalid: new Set(),        // 明确无效（HTTP 400/404），持久化
  empty: new Set(),          // 该商店暂无榜单（内存态，重启后重试）
  lastKey: null,             // 上一次返回的歌曲 key（避免连续重复）
  lastCountry: null,
  refreshing: false,
};

let jamendoPool = []; // Jamendo 模式：全局歌曲池（完整 mp3）

// ---- 音频本地缓存 ----
let urlMap = {};     // id -> {url, type}
let warmQueue = [];  // 待预下载的 id 队列
let warmActive = 0;
const warmInFlight = new Set();
const playedAudioIds = new Set();
let warmReady = [];  // 已完整缓存的 id（可秒开，优先返回）

function loadUrlMap() {
  try {
    urlMap = JSON.parse(fs.readFileSync(URL_MAP_FILE, 'utf8')) || {};
  } catch (e) {
    urlMap = {};
  }
}

function saveUrlMap() {
  try {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    fs.writeFileSync(URL_MAP_FILE, JSON.stringify(urlMap));
  } catch (e) { /* ignore */ }
}

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

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 旧格式池条目没有 id 时，从远程 URL 推导稳定 id
function ensureSongId(s) {
  if (s.id) return s.id;
  const m = /trackid=(\d+)/.exec(s.streamUrl || '');
  s.id = m ? m[1] : 'j' + hashString(s.streamUrl || '');
  return s.id;
}

function audioCachePath(id) {
  return path.join(AUDIO_DIR, id + '.mp3');
}

// 预下载：把歌曲音频缓存到本地（并发受限，后台执行）
function warmAudio(id) {
  const entry = urlMap[id];
  if (!entry || warmQueue.includes(id) || warmInFlight.has(id)) return;
  if (fs.existsSync(audioCachePath(id))) return; // 已有缓存
  warmQueue.push(id);
  pumpWarm();
}

// 已缓存的歌被取走后，把它从"就绪"列表移除
function consumeWarm(id) {
  const i = warmReady.indexOf(id);
  if (i !== -1) warmReady.splice(i, 1);
}

function clearPlayedAudio(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  playedAudioIds.add(id);
  warmReady = warmReady.filter((readyId) => readyId !== id);
  warmQueue = warmQueue.filter((queuedId) => queuedId !== id);
  let removed = false;
  for (const file of [audioCachePath(id), audioCachePath(id) + '.tmp']) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[audio] played cache cleanup failed: ' + error.message);
    }
  }
  return removed;
}

// 维持"始终有 WARM_TARGET 首歌在下载/已下载"的流水线
function topUpWarm() {
  if (MODE !== 'jamendo') return;
  if (jamendoPool.filter(s => !deliveredSongs.has(s.id)).length < 3 && Date.now() >= discoveryRetryAt) {
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
        !deliveredSongs.has(s.id) &&
        !warmReady.includes(s.id) &&
        !warmQueue.includes(s.id) &&
        !warmInFlight.has(s.id) &&
        !fs.existsSync(audioCachePath(s.id))
    );
    shuffle(candidates);
    for (const s of candidates.slice(0, need)) warmQueue.push(s.id);
    pumpWarm();
  }
  // 音频预缓存和国家/地区预缓存始终使用同一批“下一首”候选。
  prefetchUpcomingCountries();
}

async function pumpWarm() {
  while (warmActive < WARM_MAX && warmQueue.length) {
    const id = warmQueue.shift();
    const entry = urlMap[id];
    if (!entry) continue;
    warmActive++;
    warmInFlight.add(id);
    warmAudioTask(id, entry).finally(() => {
      warmInFlight.delete(id);
      warmActive--;
      pumpWarm();
    });
  }
}

async function warmAudioTask(id, entry) {
  const tmp = audioCachePath(id) + '.tmp';
  const target = audioCachePath(id);
  try {
    const res = await fetch(entry.url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok || !res.body) {
      if (res.body) await res.body.cancel();
      return;
    }
    // pipeline 从写入开始就处理错误、背压和取消，磁盘失败不会变成未捕获异常。
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    if (playedAudioIds.has(id)) {
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      return;
    }
    fs.renameSync(tmp, target);
    if (playedAudioIds.has(id)) {
      try { fs.unlinkSync(target); } catch (e) { /* ignore */ }
      return;
    }
    if (!warmReady.includes(id)) warmReady.push(id);
    evictOldest();
    console.log('[audio] cached ' + id + ' (' + (fs.statSync(target).size / 1024).toFixed(0) + 'KB, ready=' + warmReady.length + ')');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
  }
}

function evictOldest() {
  try {
    const files = fs.readdirSync(AUDIO_DIR)
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => ({ f, t: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    while (files.length > AUDIO_MAX) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(AUDIO_DIR, old.f)); } catch (e) { /* ignore */ }
      consumeWarm(old.f.slice(0, -4)); // 同步移除就绪列表
    }
  } catch (e) { /* ignore */ }
}

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
      const size = (await file.stat()).size;
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
          res.writeHead(416, { 'Content-Range': 'bytes */' + size });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': entry.type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Content-Length': size,
          'Accept-Ranges': 'bytes',
        });
      }
      if (req.method === 'HEAD' || size === 0) res.end();
      else await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
    } finally {
      await file.close();
    }
    return;
  }
  // 未缓存：从远程转发（流式），同时触发后台预下载，下次播放秒开
  if (req.method === 'GET') warmAudio(id);
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

function persistInvalid() {
  try {
    fs.writeFileSync(INVALID_FILE, JSON.stringify(Array.from(state.invalid)));
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 歌曲抓取
function songCachePath(code) {
  return path.join(SONGS_DIR, code + '.json');
}

// 取某国歌曲（仅 iTunes 模式使用；Jamendo 模式走全局池）
async function fetchCountrySongs(code) {
  return fetchItunesCountry(code);
}

// ---- iTunes RSS：30 秒试听（兜底模式）----
async function fetchItunesCountry(code) {
  const url = 'https://itunes.apple.com/' + code.toLowerCase() + '/rss/topsongs/limit=100/json';
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQ_TIMEOUT),
      compress: true,
    });
  } catch (e) {
    // 网络层错误（DNS/超时/重置）→ 可重试的瞬时错误
    throw new FetchError((e.cause && e.cause.code) || e.name, false);
  }
  if (res.status === 400 || res.status === 404) {
    throw new FetchError('iTunes HTTP ' + res.status, true); // 商店不存在 → 永久无效
  }
  if (!res.ok) {
    throw new FetchError('iTunes HTTP ' + res.status, false);
  }
  let j;
  try {
    j = await res.json();
  } catch (e) {
    throw new FetchError('bad response body', false);
  }
  // Apple 的 feed 结构：正常 entry 是数组，但单曲榜单时 entry 是单个对象
  const rawEntry = j && j.feed && j.feed.entry;
  const entries = Array.isArray(rawEntry) ? rawEntry : rawEntry ? [rawEntry] : [];
  if (!entries.length && !(j && j.feed)) {
    throw new FetchError('unexpected response body', false); // 非 feed 结构 → 瞬时错误
  }
  const songs = [];
  for (const e of entries) {
    const preview = (e.link || []).find(
      (l) => l.attributes && l.attributes['im:assetType'] === 'preview'
    );
    if (!preview || !preview.attributes.href) continue;
    const img = (e['im:image'] || []).slice(-1)[0]; // 取最大封面
    let streamUrl = preview.attributes.href;
    if (streamUrl.startsWith('http://')) streamUrl = 'https://' + streamUrl.slice(7);
    songs.push({
      title: (e['im:name'] && e['im:name'].label) || '未知歌曲',
      artist: (e['im:artist'] && e['im:artist'].label) || '未知歌手',
      album: (e['im:collection'] && e['im:collection']['im:name'] && e['im:collection']['im:name'].label) || '',
      streamUrl: streamUrl,
      artwork: (img && img.label) || '',
      duration: 0,
      countrycode: code,
      country: COUNTRY_NAMES[code] || code,
    });
  }
  return songs;
}

// ---- Jamendo：完整 mp3 全局歌曲池 ----
// tracks 接口不含地区；通过独立的 artists/locations 接口补充，
// 在全目录随机位置抽样，候选用完即补充，不以热门程度或国家资料完整度排序。
const POOL_TARGET = 6; // Only a small rotating look-ahead buffer.
const discovery = createDiscovery({request: fetchDiscoveryPage});
const deliveredSongs = new Set();
let discoveryRetryAt = 0;
let poolRequest = null;

async function fetchDiscoveryPage(options) {
  const params = new URLSearchParams({
    client_id: JAMENDO_ID,
    format: 'json',
    limit: options.limit,
    offset: options.offset,
    order: 'id',
    type: 'single albumtrack',
    ...(options.fullcount ? {fullcount: options.fullcount} : {audioformat:'mp32'}),
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
  return poolRequest;
}

async function fetchJamendoPool() {
  const waiting = jamendoPool.filter(s => !deliveredSongs.has(s.id));
  if (waiting.length >= POOL_TARGET) return waiting;
  const seen = new Set();
  const all = [];
  const freshUrls = {};
  const results = await discovery.sample(Math.max(1, POOL_TARGET - jamendoPool.filter(s=>!deliveredSongs.has(s.id)).length), new Set([...deliveredSongs, ...jamendoPool.map(s=>s.id)]));
  for (const t of results) {
    if (!t.audio || seen.has(String(t.id))) continue;
    seen.add(String(t.id));
    const id = String(t.id);
    all.push({id, title:t.name || '未知歌曲', artist:t.artist_name || '未知歌手',
      artistId:String(t.artist_id || ''), album:t.album_name || '', streamUrl:t.audio,
      artwork:t.album_image || t.image || '', duration:Number(t.duration)||0,
      countrycode:'',country:'未知地区'});
    freshUrls[id] = {url:t.audio,type:'audio/mpeg'};
  }
  if (!all.length) throw new FetchError('Jamendo returned no playable tracks; previous pool retained', false);
  // Only the next few candidates and short metadata history are retained.
  const pending = jamendoPool.filter(s => !deliveredSongs.has(s.id));
  const history = jamendoPool.filter(s => deliveredSongs.has(s.id)).slice(-16);
  const next = [...history, ...pending, ...all];
  writeJsonAtomic(POOL_FILE, [...pending, ...all]);
  jamendoPool = next;
  Object.assign(urlMap, freshUrls);
  saveUrlMap();
  console.log('[songs] Jamendo pool: ' + all.length + ' new random tracks');
  prefetchCountryBatch(all);
  topUpWarm();
  prefetchUpcomingCountries();
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
      scheduleJamendoPoolSave();
      if (deliveredSongs.size > 1000) deliveredSongs.delete(deliveredSongs.values().next().value);
      return s;
    }
  }
  const s = candidates[randomIndex(candidates.length)];
  if (s) { playedAudioIds.delete(s.id); deliveredSongs.add(s.id); scheduleJamendoPoolSave(); }
  return s;
}

async function waitForWarmAudio() {
  if (MODE !== 'jamendo' || warmReady.length || (!warmActive && !warmQueue.length)) return;
  const deadline = Date.now() + WARM_READY_WAIT_MS;
  while (!warmReady.length && (warmActive || warmQueue.length) && Date.now() < deadline) {
    await sleep(100);
  }
}

// 取某国歌曲：内存 → 磁盘 → 网络（惰性，瞬时失败自动重试一次）
async function getSongs(code, refresh = false) {
  let songs = state.songsByCountry.get(code);
  const previous = songs;
  if (songs && !refresh) return songs;
  if (!refresh) {
    try {
      songs = JSON.parse(fs.readFileSync(songCachePath(code), 'utf8'));
      if (Array.isArray(songs) && songs.length) {
        state.songsByCountry.set(code, songs);
        return songs;
      }
    } catch (e) { /* 无缓存或损坏 */ }
  }
  if (!refresh && (state.invalid.has(code) || state.empty.has(code))) return [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      songs = await fetchCountrySongs(code);
    } catch (e) {
      if (e.definitive) {
        if (previous && previous.length) return previous;
        state.invalid.add(code);
        persistInvalid();
        return [];
      }
      if (attempt === 0) await sleep(400); // 瞬时错误：稍等重试一次
      continue;
    }
    if (!songs.length) {
      if (previous && previous.length) return previous;
      state.empty.add(code); // 该商店暂无榜单（不落盘，重启后重试）
      return [];
    }
    state.songsByCountry.set(code, songs);
    state.invalid.delete(code);
    state.empty.delete(code);
    try {
      writeJsonAtomic(songCachePath(code), songs);
    } catch (e) {
      console.warn('[songs] cache write failed: ' + e.message);
    }
    return songs;
  }
  return previous || []; // 刷新失败仍使用旧榜单；冷启动失败不做永久标记。
}

// ---------------------------------------------------------------- 随机选歌
function randomIndex(n) {
  return (Math.random() * n) | 0;
}

function pickCountryCode() {
  // 85% 从已缓存国家里选（秒回），15% 探索新国家（约 0.4s）
  const bad = (c) => state.invalid.has(c) || state.empty.has(c);
  const cached = COUNTRY_CODES.filter(
    (c) => !bad(c) && state.songsByCountry.has(c) && state.songsByCountry.get(c).length
  );
  if (cached.length && Math.random() < 0.85) return cached[randomIndex(cached.length)];
  const all = COUNTRY_CODES.filter((c) => !bad(c));
  if (!all.length) return COUNTRY_CODES[randomIndex(COUNTRY_CODES.length)];
  return all[randomIndex(all.length)];
}

async function pickSong(cancelled = () => false) {
  if (MODE === 'jamendo') {
    if (!jamendoPool.some(s => !deliveredSongs.has(s.id))) await ensureJamendoPool();
    await waitForWarmAudio();
    return pickJamendoSong();
  }
  for (let tries = 0; tries < 12; tries++) {
    if (cancelled()) return null;
    let code = pickCountryCode();
    if (code === state.lastCountry) code = pickCountryCode();
    const songs = await getSongs(code);
    if (!songs.length) continue;
    const s = songs[randomIndex(songs.length)];
    const key = s.countrycode + '|' + s.title;
    if (key !== state.lastKey || songs.length === 1) {
      state.lastKey = key;
      state.lastCountry = code;
      return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------- 后台预取
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function primeCountries(refresh = false) {
  if (state.refreshing) return;
  state.refreshing = true;
  const bad = (c) => state.invalid.has(c) || state.empty.has(c);
  const pending = COUNTRY_CODES.filter(
    (c) => refresh || (!bad(c) && !state.songsByCountry.has(c))
  );
  shuffle(pending);
  console.log('[songs] priming ' + pending.length + ' countries (concurrency 5)…');
  const CONC = 5;
  let i = 0;
  let ok = 0;
  const worker = async () => {
    while (i < pending.length) {
      const code = pending[i++];
      const songs = await getSongs(code, refresh);
      if (songs.length) ok++;
      if ((i + 1) % 25 === 0) {
        console.log('[songs] primed ' + state.songsByCountry.size + ' / ' + pending.length);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: CONC }, worker));
    persistInvalid();
  } finally {
    state.refreshing = false;
  }
  console.log('[songs] priming done: ' + ok + ' countries with songs, ' +
    state.invalid.size + ' invalid, ' + state.empty.size + ' empty');
}

function loadInvalidSet() {
  try {
    const arr = JSON.parse(fs.readFileSync(INVALID_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const c of arr) state.invalid.add(c);
  } catch (e) { /* ignore */ }
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
let poolSaveTimer = null;
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

function scheduleJamendoPoolSave() {
  if (MODE !== 'jamendo' || poolSaveTimer || !jamendoPool.length) return;
  poolSaveTimer = setTimeout(() => {
    poolSaveTimer = null;
    try {
      fs.mkdirSync(SONGS_DIR, { recursive: true });
      fs.writeFileSync(POOL_FILE, JSON.stringify(jamendoPool.filter(s => !deliveredSongs.has(s.id))));
    } catch (e) { /* ignore */ }
  }, 250);
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
  if (changed) scheduleJamendoPoolSave();
}

function clearUntrustedPoolCountry(song) {
  if (
    !song.countrycode &&
    song.country === '未知地区' &&
    !song.countrySource &&
    !song.countryResolvedAt &&
    !song.countryResolverVersion
  ) {
    return false;
  }
  song.countrycode = '';
  song.country = '未知地区';
  delete song.countrySource;
  delete song.countrySourceUrl;
  delete song.countryResolvedAt;
  delete song.countryResolverVersion;
  return true;
}

function sanitizeLoadedJamendoPool() {
  let changed = false;
  for (const song of jamendoPool) {
    const code = String(song.countrycode || '').toUpperCase();
    const trusted =
      TRUSTED_COUNTRY_SOURCES.has(song.countrySource) &&
      song.countryResolverVersion === COUNTRY_RESOLVER_VERSION &&
      isFreshCountryAnnotation(song) &&
      /^[A-Z]{2}$/.test(code) &&
      COUNTRY_NAMES[code];
    if (!trusted) changed = clearUntrustedPoolCountry(song) || changed;
  }
  return changed;
}

function loadArtistCountries() {
  let loaded = {};
  try {
    loaded = JSON.parse(fs.readFileSync(ARTIST_COUNTRY_FILE, 'utf8')) || {};
  } catch (e) {
    loaded = {};
  }
  artistCountry = {};
  let changed = false;
  for (const [name, rec] of Object.entries(loaded)) {
    // v8 positive MusicBrainz results remain valid; only its month-long misses
    // must be retried now that another source is available.
    if (rec && rec.resolverVersion === 8 && rec.source === 'mb' && COUNTRY_NAMES[rec.code]) {
      rec.resolverVersion = COUNTRY_RESOLVER_VERSION;
      changed = true;
    }
    // 丢弃旧版 Bing 结果；它们没有可验证的艺术家-国家对应关系。
    if (
      !rec ||
      rec.resolverVersion !== COUNTRY_RESOLVER_VERSION ||
      !CACHEABLE_COUNTRY_SOURCES.has(rec.source)
    ) {
      changed = true;
      continue;
    }
    artistCountry[name] = rec;
  }
  if (changed) {
    saveArtistCountries();
  }
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
  })().finally(() => { delete inflightCountry[key]; });
  inflightCountry[key] = p;
  return p;
}

function prefetchCountryBatch(songs) {
  const pending = songs.filter(s => s.artistId && !countryRecordForSong(s) && !inflightCountry[normalizeArtistName(s.artist)]);
  if (!pending.length) return;
  const ids = [...new Set(pending.map(s => s.artistId))];
  const batch = (async () => {
    const params = new URLSearchParams({client_id:JAMENDO_ID,format:'json',limit:'200',id:ids.join(' ')});
    const res = await fetch('https://api.jamendo.com/v3.0/artists/locations/?' + params, {
      headers:{'User-Agent':UA}, signal:AbortSignal.timeout(REQ_TIMEOUT),
    });
    if (!res.ok) return [];
    const result = await res.json();
    return result.headers && result.headers.status === 'success' ? result.results || [] : [];
  })().catch(() => []);
  for (const song of pending) {
    const key = normalizeArtistName(song.artist);
    const namesakes = new Set(jamendoPool.filter(s => normalizeArtistName(s.artist) === key).map(s => s.artistId).filter(Boolean));
    const task = batch.then(artists => {
      const location = selectLocation(artists, key, song.artistId, COUNTRY_NAMES);
      if (!location) return null; // Missing metadata can still use MusicBrainz.
      const rec = {...location,country:COUNTRY_NAMES[location.code],resolverVersion:COUNTRY_RESOLVER_VERSION,ts:Date.now()};
      artistCountry[key] = rec;
      annotatePoolCountry(key,rec);
      saveArtistCountries();
      return rec;
    }).catch(() => null);
    if (namesakes.size === 1) {
      inflightCountry[key] = task.finally(() => { delete inflightCountry[key]; });
    }
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
  for (const song of preferred.concat(remaining.slice(0, COUNTRY_PREFETCH_TARGET))) {
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
    const respond = async (s) => {
      if (res.destroyed) return;
      const out = Object.assign({}, s);
      // Jamendo 模式：走本地 /audio 代理（已缓存则秒开，未缓存则转发并后台预下载）
      if (MODE === 'jamendo' && s.id) {
        out.streamUrl = localUrl(s.id);
        consumeWarm(s.id); // 这首歌被取走，从就绪列表移除
        topUpWarm();       // 立刻补一首新的进预下载流水线
      }
      // 国家信息：当前歌曲拥有最高优先级。解析与音频预缓存并行进行，
      // 只给当前 API 请求留一小段时间拿到结果，超时则让前端继续轮询。
      if (MODE === 'jamendo' && s.artist) {
        let rec = countryRecordForSong(s);
        if (!rec) {
          rec = await Promise.race([
            resolveArtistCountry(s.artist),
            sleep(COUNTRY_LOOKUP_WAIT_MS).then(() => null),
          ]);
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
    const cc = (urlObj.searchParams.get('country') || '').toUpperCase();
    if (cc) {
      if (MODE === 'jamendo') { json(res, 404, { error: 'Jamendo 模式无国家数据' }); return; }
      if (!COUNTRY_CODES.includes(cc)) { json(res, 404, { error: '未知国家码' }); return; }
      getSongs(cc).then((songs) => {
        if (!songs.length) { json(res, 404, { error: '该国家暂无歌曲数据' }); return; }
        const s = songs[randomIndex(songs.length)];
        state.lastKey = s.countrycode + '|' + s.title;
        state.lastCountry = cc;
        respond(s).catch(() => json(res, 500, { error: 'fetch failed' }));
      }).catch(() => json(res, 500, { error: 'fetch failed' }));
      return;
    }
    pickSong(() => res.destroyed).then((s) => {
      if (!s) { json(res, 503, { error: '歌曲库尚未就绪，请稍后重试' }); return; }
      respond(s).catch(() => json(res, 500, { error: 'fetch failed' }));
    }).catch(() => json(res, 500, { error: 'fetch failed' }));
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
    if (MODE === 'jamendo') { json(res, 200, []); return; }
    const arr = COUNTRY_CODES
      .filter((c) => state.songsByCountry.has(c))
      .map((c) => ({
        code: c,
        name: COUNTRY_NAMES[c] || c,
        count: state.songsByCountry.get(c).length,
      }))
      .sort((a, b) => b.count - a.count);
    json(res, 200, arr);
    return;
  }
  if (pathname === '/api/info') {
    let songs = 0;
    for (const list of state.songsByCountry.values()) songs += list.length;
    if (MODE === 'jamendo') songs = jamendoPool.length;
    json(res, 200, {
      mode: MODE,
      countries: MODE === 'jamendo' ? 0 : state.songsByCountry.size,
      total: COUNTRY_CODES.length,
      songs,
      invalid: state.invalid.size,
      empty: state.empty.size,
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
    console.log('[songs] MODE: iTunes 30 秒试听（未配置 Jamendo key）');
    console.log('[songs] 想播放完整歌曲？免费获取 key：https://devportal.jamendo.com');
    console.log('[songs] 注册后创建应用，把 client_id 写入 data/config.json 的 jamendoClientId 字段（或设环境变量 JAMENDO_CLIENT_ID），重启即切换为全曲模式');
  }
  fs.mkdirSync(SONGS_DIR, { recursive: true });
  loadInvalidSet();
  loadUrlMap();
  loadArtistCountries();

  if (MODE === 'jamendo') {
    // Jamendo 模式：从磁盘加载全局歌曲池，后台补抓
    try {
      const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
      if (Array.isArray(arr) && arr.length) {
        shuffle(arr);
        jamendoPool = arr.slice(0, POOL_TARGET);
        let changed = false;
        for (const s of arr) {
          if (!s.id) { ensureSongId(s); changed = true; }
          if (s.id && s.streamUrl && !urlMap[s.id]) {
            urlMap[s.id] = { url: s.streamUrl, type: 'audio/mpeg' };
          }
        }
        if (sanitizeLoadedJamendoPool()) changed = true;
        saveUrlMap();
        if (changed) {
          try { fs.writeFileSync(POOL_FILE, JSON.stringify(jamendoPool)); } catch (e) { /* ignore */ }
        }
        console.log('[songs] restored ' + jamendoPool.length + ' look-ahead candidates');
      }
    } catch (e) { /* 无池缓存 */ }
    // 已有音频缓存 → 直接进入"就绪"列表（重启后依然秒开）
    try {
      const cached = fs.readdirSync(AUDIO_DIR)
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => f.slice(0, -4))
        .filter((id) => urlMap[id] && jamendoPool.some(s=>s.id===id));
      for (const id of cached.slice(0,WARM_TARGET)) if (!warmReady.includes(id)) warmReady.push(id);
      console.log('[audio] ' + warmReady.length + ' songs already cached on disk');
    } catch (e) { /* ignore */ }
    // 启动音频与国家/地区双预取流水线（均后台执行，不阻塞启动）。
    topUpWarm();
    ensureJamendoPool().then(() => {
      topUpWarm();
      prefetchUpcomingCountries();
      backfillArtistCountries();
    }).catch((e) =>
      console.error('[songs] pool fetch failed: ' + e.message));
  } else {
    // iTunes 模式：从磁盘载入已有缓存（秒级）
    let loaded = 0;
    for (const code of COUNTRY_CODES) {
      try {
        const songs = JSON.parse(fs.readFileSync(songCachePath(code), 'utf8'));
        if (Array.isArray(songs) && songs.length) {
          state.songsByCountry.set(code, songs);
          loaded++;
        }
      } catch (e) { /* 无缓存 */ }
    }
    console.log('[songs] loaded ' + loaded + ' countries from disk cache');
    // 后台预取剩余国家（不阻塞启动）
    primeCountries().catch((error) => console.error('[songs] priming failed: ' + error.message));
  }

  setInterval(async () => {
    // 在后台准备替代数据；网络失败时保留上一次可用的曲库。
    if (state.refreshing) return;
    if (MODE === 'jamendo') {
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
    } else {
      console.log('[songs] refreshing all country charts…');
      try {
        await primeCountries(true);
      } catch (error) {
        console.error('[songs] chart refresh failed: ' + error.message);
      }
    }
  }, REFRESH_MS);

  server.listen(PORT, HOST, () => {
    console.log('[server] World Vinyl running at http://' + HOST + ':' + PORT);
    console.log('[server] press R on the page to skip to a random song from a random country');
  });
})();
