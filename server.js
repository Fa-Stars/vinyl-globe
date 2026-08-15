'use strict';
// 世界唱片机 —— 后端
//  数据源（双模式）：
//    ① Jamendo（推荐，全曲播放）：正版免费 CC 音乐，按"艺术家国籍"过滤，返回完整 mp3。
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
// 运行：node server.js   （Node >= 18，无任何第三方依赖）

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const UA = 'vinyl-globe/1.0 (world vinyl turntable)';
const REQ_TIMEOUT = 12000;              // 单次数据源请求超时
const REFRESH_MS = 12 * 3600 * 1000;    // 每 12 小时整体刷新一次缓存

// ---- 配置：Jamendo client_id（环境变量优先，其次 data/config.json）----
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}
const JAMENDO_ID = (process.env.JAMENDO_CLIENT_ID || loadConfig().jamendoClientId || '').trim();
const MODE = JAMENDO_ID ? 'jamendo' : 'itunes';
const SONGS_DIR = path.join(ROOT, 'data', MODE === 'jamendo' ? 'jamendo' : 'songs'); // data/jamendo 或 data/songs
const INVALID_FILE = path.join(SONGS_DIR, '_invalid.json');
const POOL_FILE = path.join(SONGS_DIR, 'pool.json'); // Jamendo 全局歌曲池缓存
const AUDIO_DIR = path.join(ROOT, 'data', 'audio');   // 音频本地缓存（预下载）
const URL_MAP_FILE = path.join(AUDIO_DIR, '_urls.json'); // id -> 远程 URL 映射
const AUDIO_MAX = 60;    // 音频缓存文件数上限（约 60 × 4MB ≈ 240MB）
const WARM_MAX = 3;      // 同时预下载的并发上限
const WARM_TARGET = 10;  // 随时保持 10 首歌处于"已下载 / 下载中"，保证换歌流畅

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
  ZW:'津巴布韦',
};

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
  if (!entry || warmQueue.includes(id)) return;
  if (fs.existsSync(audioCachePath(id))) return; // 已有缓存
  warmQueue.push(id);
  pumpWarm();
}

// 已缓存的歌被取走后，把它从"就绪"列表移除
function consumeWarm(id) {
  const i = warmReady.indexOf(id);
  if (i !== -1) warmReady.splice(i, 1);
}

// 维持"始终有 WARM_TARGET 首歌在下载/已下载"的流水线
function topUpWarm() {
  if (MODE !== 'jamendo') return;
  const inFlight = warmReady.length + warmQueue.length;
  const need = WARM_TARGET - inFlight;
  if (need <= 0) return;
  const candidates = jamendoPool.filter(
    (s) =>
      s.id &&
      !warmReady.includes(s.id) &&
      !warmQueue.includes(s.id) &&
      !fs.existsSync(audioCachePath(s.id))
  );
  shuffle(candidates);
  for (const s of candidates.slice(0, need)) warmQueue.push(s.id);
  pumpWarm();
}

async function pumpWarm() {
  while (warmActive < WARM_MAX && warmQueue.length) {
    const id = warmQueue.shift();
    const entry = urlMap[id];
    if (!entry) continue;
    warmActive++;
    warmAudioTask(id, entry).finally(() => {
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
    if (!res.ok || !res.body) return;
    const out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    // 边下载边写入（不占用内存缓冲整曲）
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      out.end();
    });
    fs.renameSync(tmp, target);
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
  const entry = urlMap[id];
  if (!entry) {
    res.writeHead(404);
    res.end('unknown audio');
    return;
  }
  const file = audioCachePath(id);
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (start >= size) {
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
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': entry.type,
        'Content-Length': size,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file).pipe(res);
    }
    return;
  }
  // 未缓存：从远程转发（流式），同时触发后台预下载，下次播放秒开
  warmAudio(id);
  try {
    const upstream = await fetch(entry.url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(60000),
    });
    if (!upstream.ok || !upstream.body) {
      res.writeHead(502);
      res.end('upstream failed');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': 'no-store',
    });
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end();
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
// 注意：Jamendo API 不提供艺术家国家字段（country/location 参数均无效），
// 因此 Jamendo 模式不再按国家组织，改为"全局热门曲目池随机"。
const POOL_TARGET = 1200; // 池目标大小（分页累积）

async function fetchJamendoPage(offset) {
  const params = new URLSearchParams({
    client_id: JAMENDO_ID,
    format: 'json',
    limit: '120',
    offset: String(offset),
    order: 'popularity_total',
    audioformat: 'mp32', // mp3 128kbps
  });
  const url = 'https://api.jamendo.com/v3.0/tracks/?' + params.toString();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQ_TIMEOUT),
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
  if (!results.length && !(j && j.headers && j.headers.status === 'OK')) {
    throw new FetchError('unexpected response body', false);
  }
  return results;
}

async function ensureJamendoPool(force) {
  if (jamendoPool.length && !force) return jamendoPool;
  const seen = new Set();
  const all = [];
  for (let offset = 0; offset < 2000 && all.length < POOL_TARGET; offset += 120) {
    let results = null;
    for (let attempt = 0; attempt < 2 && !results; attempt++) {
      try {
        results = await fetchJamendoPage(offset);
      } catch (e) {
        if (e.definitive) throw e;
        if (attempt === 0) await sleep(500);
      }
    }
    if (!results) break;
    for (const t of results) {
      if (!t.audio || seen.has(t.id)) continue;
      seen.add(t.id);
      const id = String(t.id);
      all.push({
        id: id,
        title: t.name || '未知歌曲',
        artist: t.artist_name || '未知歌手',
        album: t.album_name || '',
        streamUrl: t.audio, // 完整 mp3（远程，内部字段）
        artwork: t.album_image || t.image || '',
        duration: Number(t.duration) || 0,
        countrycode: '',
        country: '未知地区', // Jamendo API 无国家信息
      });
      urlMap[id] = { url: t.audio, type: 'audio/mpeg' };
    }
    if (results.length < 120) break;
    await sleep(150); // 对 Jamendo 友好一些
  }
  if (all.length) {
    jamendoPool = all;
    saveUrlMap();
    try {
      fs.mkdirSync(SONGS_DIR, { recursive: true });
      fs.writeFileSync(POOL_FILE, JSON.stringify(all));
    } catch (e) {
      console.warn('[songs] pool write failed: ' + e.message);
    }
    console.log('[songs] Jamendo pool: ' + all.length + ' full tracks');
  }
  return all;
}

function pickJamendoSong() {
  if (!jamendoPool.length) return null;
  // 优先返回已缓存（秒开）的歌曲；就绪列表为空时才退回随机
  const readySongs = warmReady
    .map((id) => jamendoPool.find((s) => s.id === id))
    .filter(Boolean);
  const candidates = readySongs.length ? readySongs : jamendoPool;
  for (let i = 0; i < 10; i++) {
    const s = candidates[randomIndex(candidates.length)];
    const key = s.title + '|' + s.artist;
    if (key !== state.lastKey) {
      state.lastKey = key;
      return s;
    }
  }
  return candidates[randomIndex(candidates.length)];
}

// 取某国歌曲：内存 → 磁盘 → 网络（惰性，瞬时失败自动重试一次）
async function getSongs(code) {
  let songs = state.songsByCountry.get(code);
  if (songs) return songs;
  try {
    songs = JSON.parse(fs.readFileSync(songCachePath(code), 'utf8'));
    if (Array.isArray(songs) && songs.length) {
      state.songsByCountry.set(code, songs);
      return songs;
    }
  } catch (e) { /* 无缓存或损坏 */ }
  if (state.invalid.has(code) || state.empty.has(code)) return [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      songs = await fetchCountrySongs(code);
    } catch (e) {
      if (e.definitive) {
        state.invalid.add(code);
        persistInvalid();
        return [];
      }
      if (attempt === 0) await sleep(400); // 瞬时错误：稍等重试一次
      continue;
    }
    if (!songs.length) {
      state.empty.add(code); // 该商店暂无榜单（不落盘，重启后重试）
      return [];
    }
    state.songsByCountry.set(code, songs);
    try {
      fs.mkdirSync(SONGS_DIR, { recursive: true });
      fs.writeFileSync(songCachePath(code), JSON.stringify(songs));
    } catch (e) {
      console.warn('[songs] cache write failed: ' + e.message);
    }
    return songs;
  }
  return []; // 两次瞬时失败：本次返回空，但不标记，稍后可重试
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

async function pickSong() {
  if (MODE === 'jamendo') return pickJamendoSong();
  for (let tries = 0; tries < 12; tries++) {
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

async function primeCountries() {
  if (state.refreshing) return;
  state.refreshing = true;
  const bad = (c) => state.invalid.has(c) || state.empty.has(c);
  const pending = COUNTRY_CODES.filter(
    (c) => !bad(c) && !state.songsByCountry.has(c)
  );
  shuffle(pending);
  console.log('[songs] priming ' + pending.length + ' countries (concurrency 5)…');
  const CONC = 5;
  let i = 0;
  let ok = 0;
  const worker = async () => {
    while (i < pending.length) {
      const code = pending[i++];
      const songs = await getSongs(code);
      if (songs.length) ok++;
      if ((i + 1) % 25 === 0) {
        console.log('[songs] primed ' + state.songsByCountry.size + ' / ' + pending.length);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  persistInvalid();
  state.refreshing = false;
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
// 链路：MusicBrainz（结构化，限速 1req/s）→ Bing 搜索（cn.bing.com 可达）多数投票
// 结果缓存到 data/artist-countries.json，30 天内不重复搜索
// ================================================================
const ARTIST_COUNTRY_FILE = path.join(ROOT, 'data', 'artist-countries.json');
let artistCountry = {};   // artistName -> {code, country, source, ts}
let countryQueue = [];    // 后台回填队列
let countryPumping = false;
const inflightCountry = {}; // artistName -> Promise（去重）
const mbRef = { v: 0 };
const bingRef = { v: 0 };

const CN_NAMES = {
  美国:'US',英国:'GB',法国:'FR',德国:'DE',日本:'JP',澳大利亚:'AU',加拿大:'CA',俄罗斯:'RU',
  意大利:'IT',西班牙:'ES',荷兰:'NL',瑞典:'SE',挪威:'NO',丹麦:'DK',芬兰:'FI',波兰:'PL',
  乌克兰:'UA',奥地利:'AT',瑞士:'CH',比利时:'BE',葡萄牙:'PT',巴西:'BR',墨西哥:'MX',
  阿根廷:'AR',智利:'CL',哥伦比亚:'CO',秘鲁:'PE',委内瑞拉:'VE',印度:'IN',印度尼西亚:'ID',
  泰国:'TH',越南:'VN',韩国:'KR',中国:'CN',新加坡:'SG',马来西亚:'MY',菲律宾:'PH',
  土耳其:'TR',希腊:'GR',以色列:'IL',伊朗:'IR',埃及:'EG',南非:'ZA',尼日利亚:'NG',
  肯尼亚:'KE',新西兰:'NZ',爱尔兰:'IE',捷克:'CZ',匈牙利:'HU',罗马尼亚:'RO',克罗地亚:'HR',
  塞尔维亚:'RS',保加利亚:'BG',斯洛伐克:'SK',斯洛文尼亚:'SI',爱沙尼亚:'EE',拉脱维亚:'LV',
  立陶宛:'LT',冰岛:'IS',卢森堡:'LU',马耳他:'MT',塞浦路斯:'CY',白俄罗斯:'BY',摩尔多瓦:'MD',
  亚美尼亚:'AM',格鲁吉亚:'GE',阿塞拜疆:'AZ',哈萨克斯坦:'KZ',乌兹别克斯坦:'UZ',蒙古:'MN',
  巴基斯坦:'PK',孟加拉国:'BD',斯里兰卡:'LK',尼泊尔:'NP',古巴:'CU',牙买加:'JM',巴拿马:'PA',
  哥斯达黎加:'CR',乌拉圭:'UY',巴拉圭:'PY',玻利维亚:'BO',厄瓜多尔:'EC',摩洛哥:'MA',
  阿尔及利亚:'DZ',突尼斯:'TN',黎巴嫩:'LB',约旦:'JO',沙特阿拉伯:'SA',阿联酋:'AE',
  卡塔尔:'QA',科威特:'KW',伊拉克:'IQ',摩纳哥:'MC',安道尔:'AD',列支敦士登:'LI',
};

const EN_NAMES = {
  'United States':'US','United Kingdom':'GB','USA':'US','France':'FR','Germany':'DE',
  'Japan':'JP','Australia':'AU','Canada':'CA','Russia':'RU','Italy':'IT','Spain':'ES',
  'Netherlands':'NL','Sweden':'SE','Norway':'NO','Denmark':'DK','Finland':'FI','Poland':'PL',
  'Ukraine':'UA','Austria':'AT','Switzerland':'CH','Belgium':'BE','Portugal':'PT','Brazil':'BR',
  'Mexico':'MX','Argentina':'AR','Chile':'CL','Colombia':'CO','Peru':'PE','Venezuela':'VE',
  'India':'IN','Indonesia':'ID','Thailand':'TH','Vietnam':'VN','South Korea':'KR','Korea':'KR',
  'China':'CN','Singapore':'SG','Malaysia':'MY','Philippines':'PH','Turkey':'TR','Greece':'GR',
  'Israel':'IL','Iran':'IR','Egypt':'EG','South Africa':'ZA','Nigeria':'NG','Kenya':'KE',
  'New Zealand':'NZ','Ireland':'IE','Czech Republic':'CZ','Czechia':'CZ','Hungary':'HU',
  'Romania':'RO','Croatia':'HR','Serbia':'RS','Bulgaria':'BG','Slovakia':'SK','Slovenia':'SI',
  'Estonia':'EE','Latvia':'LV','Lithuania':'LT','Iceland':'IS','Luxembourg':'LU','Malta':'MT',
  'Cyprus':'CY','Belarus':'BY','Moldova':'MD','Armenia':'AM','Georgia':'GE','Azerbaijan':'AZ',
  'Kazakhstan':'KZ','Uzbekistan':'UZ','Mongolia':'MN','Pakistan':'PK','Bangladesh':'BD',
  'Sri Lanka':'LK','Nepal':'NP','Cuba':'CU','Jamaica':'JM','Panama':'PA','Costa Rica':'CR',
  'Uruguay':'UY','Paraguay':'PY','Bolivia':'BO','Ecuador':'EC','Morocco':'MA','Algeria':'DZ',
  'Tunisia':'TN','Lebanon':'LB','Jordan':'JO','Saudi Arabia':'SA','UAE':'AE','Qatar':'QA',
  'Kuwait':'KW','Iraq':'IQ','Scotland':'GB','England':'GB','Wales':'GB','Puerto Rico':'US',
};

const EN_ADJ = {
  American:'US','British':'GB','English':'GB','Scottish':'GB','Welsh':'GB','French':'FR',
  German:'DE','Japanese':'JP','Australian':'AU','Canadian':'CA','Russian':'RU','Italian':'IT',
  Spanish:'ES','Dutch':'NL','Swedish':'SE','Norwegian':'NO','Danish':'DK','Finnish':'FI',
  Polish:'PL','Ukrainian':'UA','Austrian':'AT','Swiss':'CH','Belgian':'BE','Portuguese':'PT',
  Brazilian:'BR','Mexican':'MX','Argentine':'AR','Argentinian':'AR','Chilean':'CL',
  Colombian:'CO','Peruvian':'PE','Venezuelan':'VE','Indian':'IN','Indonesian':'ID','Thai':'TH',
  Vietnamese:'VN','South Korean':'KR','Korean':'KR','Chinese':'CN','Singaporean':'SG',
  Malaysian:'MY','Filipino':'PH','Turkish':'TR','Greek':'GR','Israeli':'IL','Iranian':'IR',
  Egyptian:'EG','South African':'ZA','Nigerian':'NG','Kenyan':'KE','New Zealander':'NZ',
  Irish:'IE','Czech':'CZ','Hungarian':'HU','Romanian':'RO','Croatian':'HR','Serbian':'RS',
  Bulgarian:'BG','Slovak':'SK','Slovenian':'SI','Estonian':'EE','Latvian':'LV','Lithuanian':'LT',
  Icelandic:'IS','Luxembourgish':'LU','Maltese':'MT','Cypriot':'CY','Belarusian':'BY',
  Moldovan:'MD','Armenian':'AM','Georgian':'GE','Azerbaijani':'AZ','Kazakh':'KZ','Uzbek':'UZ',
  Mongolian:'MN','Pakistani':'PK','Bangladeshi':'BD','Sri Lankan':'LK','Nepalese':'NP',
  Cuban:'CU','Jamaican':'JM','Panamanian':'PA','Costa Rican':'CR','Uruguayan':'UY',
  Paraguayan:'PY','Bolivian':'BO','Ecuadorian':'EC','Moroccan':'MA','Algerian':'DZ',
  Tunisian:'TN','Lebanese':'LB','Jordanian':'JO','Saudi':'SA','Emirati':'AE','Qatari':'QA',
  Kuwaiti:'KW','Iraqi':'IQ','Mexican':'MX',
};

function extractCountryFromText(text) {
  if (!text) return null;
  for (const [name, code] of Object.entries(CN_NAMES)) {
    if (text.includes(name)) return code;
  }
  for (const [name, code] of Object.entries(EN_NAMES)) {
    if (new RegExp('\\b' + name + '\\b', 'i').test(text)) return code;
  }
  for (const [adj, code] of Object.entries(EN_ADJ)) {
    if (new RegExp('\\b' + adj + '\\b', 'i').test(text)) return code;
  }
  return null;
}

function loadArtistCountries() {
  try {
    artistCountry = JSON.parse(fs.readFileSync(ARTIST_COUNTRY_FILE, 'utf8')) || {};
  } catch (e) {
    artistCountry = {};
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

async function mbLookup(name) {
  await throttle(mbRef, 1100); // MusicBrainz 限速 1 req/s
  try {
    const url = 'https://musicbrainz.org/ws/2/artist/?query=artist:%22' +
      encodeURIComponent(name) + '%22&fmt=json';
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const a = (j.artists || [])[0];
    if (!a) return null;
    const iso =
      (a.area && a.area['iso_3166_1_codes'] && a.area['iso_3166_1_codes'][0]) ||
      (a.country && String(a.country).toUpperCase()) ||
      (a['begin-area'] && a['begin-area']['iso_3166_1_codes'] && a['begin-area']['iso_3166_1_codes'][0]) ||
      '';
    // 只接受标准 ISO 码（在中文国家名表里查得到），过滤 MusicBrainz 的非标码（如 XW）
    return /^[A-Z]{2}$/.test(iso) && COUNTRY_NAMES[iso] ? iso : null;
  } catch (e) {
    return null;
  }
}

async function bingLookup(name) {
  const queries = [
    '"' + name + '" musician country',
    '"' + name + '" nationality',
    '"' + name + '" 歌手 国籍',
  ];
  const votes = {};
  for (const q of queries) {
    await throttle(bingRef, 900);
    try {
      const res = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
      // 关键：剔除艺术家名字本身，避免"Jasmine Jordan → 约旦"这类误判
      text = text.split(name).join(' ');
      const code = extractCountryFromText(text);
      if (code) votes[code] = (votes[code] || 0) + 1;
    } catch (e) { /* 单次查询失败跳过 */ }
  }
  let best = null, bestN = 0;
  for (const [c, n] of Object.entries(votes)) {
    if (n > bestN) { best = c; bestN = n; }
  }
  return bestN >= 2 ? best : null; // 至少两个查询一致才采信
}

// 解析单个艺术家国籍（去重 + 缓存 + 30 天有效期）
function resolveArtistCountry(name) {
  const key = String(name || '').trim();
  if (!key) return Promise.resolve(null);
  const cached = artistCountry[key];
  if (cached && Date.now() - cached.ts < 30 * 86400 * 1000) {
    return Promise.resolve(cached.code ? cached : null);
  }
  if (inflightCountry[key]) return inflightCountry[key];
  const p = (async () => {
    let code = await mbLookup(key);
    let source = 'mb';
    if (!code) {
      code = await bingLookup(key);
      source = 'bing';
    }
    const rec = {
      code: code || null,
      country: code ? (COUNTRY_NAMES[code] || code) : null,
      source: code ? source : 'none',
      ts: Date.now(),
    };
    artistCountry[key] = rec;
    saveArtistCountries();
    return code ? rec : null;
  })().finally(() => { delete inflightCountry[key]; });
  inflightCountry[key] = p;
  return p;
}

// 后台回填：把歌曲池里所有未解析的艺术家都查一遍
function backfillArtistCountries() {
  if (MODE !== 'jamendo') return;
  const seen = new Set();
  for (const s of jamendoPool) {
    const k = String(s.artist || '').trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const cached = artistCountry[k];
    if (cached && Date.now() - cached.ts < 30 * 86400 * 1000) continue;
    if (cached && cached.source === 'none' && Date.now() - cached.ts < 7 * 86400 * 1000) continue;
    countryQueue.push(k);
  }
  pumpCountryQueue();
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
  if (pathname === '/api/song') {
    const respond = (s) => {
      const out = Object.assign({}, s);
      // Jamendo 模式：走本地 /audio 代理（已缓存则秒开，未缓存则转发并后台预下载）
      if (MODE === 'jamendo' && s.id) {
        out.streamUrl = localUrl(s.id);
        consumeWarm(s.id); // 这首歌被取走，从就绪列表移除
        topUpWarm();       // 立刻补一首新的进预下载流水线
      }
      // 国家信息：已解析的直接带上；未解析的后台开查（前端再通过 /api/country 获取）
      if (MODE === 'jamendo' && s.artist) {
        const rec = artistCountry[String(s.artist).trim()];
        if (rec && rec.code) {
          out.countrycode = rec.code;
          out.country = rec.country || COUNTRY_NAMES[rec.code] || out.country;
        } else {
          resolveArtistCountry(s.artist).catch(() => {});
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
        respond(s);
      }).catch(() => json(res, 500, { error: 'fetch failed' }));
      return;
    }
    pickSong().then((s) => {
      if (!s) { json(res, 503, { error: '歌曲库尚未就绪，请稍后重试' }); return; }
      respond(s);
    }).catch(() => json(res, 500, { error: 'fetch failed' }));
    return;
  }
  if (pathname === '/api/country') {
    // 返回歌曲所属艺术家的国家（必要时现场联网解析一次）
    const id = (urlObj.searchParams.get('id') || '').trim();
    const song = jamendoPool.find((s) => s.id === id);
    if (!song) { json(res, 404, { error: 'unknown song' }); return; }
    resolveArtistCountry(song.artist).then((rec) => {
      json(res, 200, {
        id: song.id,
        artist: song.artist,
        countrycode: rec && rec.code ? rec.code : '',
        country: rec && rec.country ? rec.country : '',
        status: rec && rec.code ? 'resolved' : 'none',
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
    const id = decodeURIComponent(pathname.slice('/audio/'.length));
    serveAudio(req, res, id).catch(() => {
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
        jamendoPool = arr;
        let changed = false;
        for (const s of arr) {
          if (!s.id) { ensureSongId(s); changed = true; }
          if (s.id && s.streamUrl && !urlMap[s.id]) {
            urlMap[s.id] = { url: s.streamUrl, type: 'audio/mpeg' };
          }
        }
        saveUrlMap();
        if (changed) {
          try { fs.writeFileSync(POOL_FILE, JSON.stringify(arr)); } catch (e) { /* ignore */ }
        }
        console.log('[songs] loaded Jamendo pool: ' + arr.length + ' full tracks from disk');
      }
    } catch (e) { /* 无池缓存 */ }
    // 已有音频缓存 → 直接进入"就绪"列表（重启后依然秒开）
    try {
      const cached = fs.readdirSync(AUDIO_DIR)
        .filter((f) => f.endsWith('.mp3'))
        .map((f) => f.slice(0, -4))
        .filter((id) => urlMap[id]);
      for (const id of cached) if (!warmReady.includes(id)) warmReady.push(id);
      console.log('[audio] ' + warmReady.length + ' songs already cached on disk');
    } catch (e) { /* ignore */ }
    // 启动 10 首预下载流水线（后台执行，不阻塞启动）
    topUpWarm();
    ensureJamendoPool().catch((e) =>
      console.error('[songs] pool fetch failed: ' + e.message));
    // 后台解析艺术家国籍（MusicBrainz + Bing，限速执行）
    setTimeout(backfillArtistCountries, 3000);
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
    primeCountries();
  }

  setInterval(() => {
    // 整库刷新：清掉缓存后重新预取
    if (state.refreshing) return;
    if (MODE === 'jamendo') {
      console.log('[songs] refreshing Jamendo pool…');
      jamendoPool = [];
      try { fs.unlinkSync(POOL_FILE); } catch (e) { /* ignore */ }
      ensureJamendoPool().then(topUpWarm).catch((e) =>
        console.error('[songs] pool refresh failed: ' + e.message));
    } else {
      console.log('[songs] refreshing all country charts…');
      state.songsByCountry.clear();
      state.invalid.clear();
      state.empty.clear();
      for (const code of COUNTRY_CODES) {
        try { fs.unlinkSync(songCachePath(code)); } catch (e) { /* ignore */ }
      }
      primeCountries();
    }
  }, REFRESH_MS);

  server.listen(PORT, () => {
    console.log('[server] World Vinyl running at http://localhost:' + PORT);
    console.log('[server] press R on the page to skip to a random song from a random country');
  });
})();
