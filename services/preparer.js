'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { createJamendoFetch } = require('../web/jamendo-fetch');
const { normalizeJamendoTrack } = require('../web/jamendo-metadata');
const { lookupJamendoCountry, countryCodes } = require('../web/jamendo-country');
const { hasMp3Frames } = require('./mp3');
const { createArtworkCache } = require('../web/artwork-cache');
const { AUDIO_LIMIT, COVER_LIMIT, ID, audioTypes, coverTypes, digest, integer, readLimited, validTrack } = require('./protocol');

async function localFile(directory, name, limit) {
  if (typeof name !== 'string' || !name) throw Error('Missing local media file');
  const root = await fs.realpath(directory);
  const file = await fs.realpath(path.resolve(root, name));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..') throw Error('Media outside manifest directory');
  const handle = await fs.open(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > limit) throw Error('Invalid media size');
    return await readLimited(handle.createReadStream({ autoClose: false }), limit);
  } finally { await handle.close(); }
}

function createPreparer({ endpoint, token, manifest, clientId, fetchMusic = createJamendoFetch() }) {
  const origin = new URL(endpoint);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) {
    throw Error('Distributor requires HTTPS or loopback HTTP');
  }
  if (origin.username || origin.password || !token || token.length < 24 || !manifest) throw Error('Missing or invalid preparer configuration');
  const dir = path.dirname(path.resolve(manifest));
  const countries = Object.fromEntries(countryCodes.map(code => [code, true]));
  const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
  const images = createArtworkCache({ fetch: fetchMusic });
  // If the distributor is full, retry that revision only after its available space changes.
  const noSpace = new Map();
  async function cloud(route, options = {}) {
    const res = await fetch(new URL(route, origin), { ...options, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      await res.body?.cancel();
      throw Object.assign(Error('Distributor returned HTTP ' + res.status), { status: res.status });
    }
    return res;
  }
  async function musicJson(url) {
    const res = await fetchMusic(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) { await res.body?.cancel(); throw Error('Jamendo HTTP ' + res.status); }
    return JSON.parse((await readLimited(res.body, 1024 * 1024)).toString());
  }
  async function prepare(entry, replace) {
    let audio, cover = Buffer.alloc(0), details = {};
    let audioType = entry.audioType || 'audio/mpeg', coverType = '';
    if (entry.provider === 'jamendo') {
      if (!clientId) throw Error('JAMENDO_CLIENT_ID required on preparer');
      const query = new URLSearchParams({ id: entry.id, client_id: clientId, format: 'json', type: 'single+albumtrack',
        include: 'licenses', audioformat: 'mp32', audiodlformat: 'mp32' });
      const result = await musicJson('https://api.jamendo.com/v3.0/tracks/?' + query);
      const row = result.results?.find(s => String(s.id) === entry.id);
      const song = normalizeJamendoTrack(row);
      if (!song || row.audiodownload_allowed !== true || !row.audiodownload?.startsWith('https://')) {
        throw Error('Track missing attribution or unavailable for download');
      }
      const response = await fetchMusic(row.audiodownload, { signal: AbortSignal.timeout(90000) });
      const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !['audio/mpeg','audio/mp3','application/octet-stream','text/html'].includes(mime)) {
        await response.body?.cancel(); throw Error('Jamendo audio unavailable');
      }
      audio = await readLimited(response.body, AUDIO_LIMIT);
      // Some Jamendo storage nodes label genuine MP3 downloads as HTML.
      if (mime === 'text/html' && !hasMp3Frames(audio)) throw Error('Jamendo returned non-audio content');
      const [location, image] = await Promise.all([
        lookupJamendoCountry(song.artist, song.artistId, { clientId, countries, fetchJson: musicJson }),
        images.get(song.artwork),
      ]);
      details = { title: song.title, artist: song.artist, artistId: song.artistId, album: song.album, duration: song.duration,
        countrycode: location.code || '', sourceUrl: song.sourceUrl, license: song.license };
      audioType = 'audio/mpeg';
      if (image && coverTypes.has(image.type)) { cover = image.body; coverType = image.type; }
    } else {
      audio = await localFile(dir, entry.file, AUDIO_LIMIT);
      details = { title: entry.title, artist: entry.artist, album: entry.album, duration: entry.duration || 0,
        countrycode: entry.countrycode || '', license: entry.license, sourceUrl: entry.sourceUrl };
      if (entry.cover) {
        coverType = entry.coverType;
        if (!coverTypes.has(coverType)) throw Error('Invalid cover type');
        cover = await localFile(dir, entry.cover, COVER_LIMIT);
      }
    }
    if (!audio.length || !audioTypes.has(audioType)) throw Error('Empty or unsupported audio');
    const track = { ...details, id: entry.id, provider: entry.provider, countryChecked: Date.now(),
      grant: entry.grant, validUntil: Date.parse(entry.validUntil),
      revision: entry.revision, country: details.countrycode ? names.of(details.countrycode) : '未知地区',
      audioType, coverType, audioHash: digest(audio), coverHash: digest(cover) };
    validTrack(track);
    const form = new FormData();
    form.set('metadata', JSON.stringify(track));
    form.set('audio', new Blob([audio], { type: audioType }), 'audio');
    if (cover.length) form.set('cover', new Blob([cover], { type: coverType }), 'cover');
    const route = '/internal/tracks/' + track.id + (replace ? '?replace=' + replace : '');
    const receipt = await (await cloud(route, { method: 'PUT', body: form })).json();
    if (receipt.id !== track.id || receipt.audioHash !== track.audioHash) throw Error('Upload receipt mismatch');
  }

  return async function runOnce() {
    const entries = JSON.parse(await fs.readFile(manifest, 'utf8'));
    if (!Array.isArray(entries)) throw Error('Expected a track manifest array');
    const allowed = new Map(), seen = new Set();
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || !ID.test(item.id) || seen.has(item.id) ||
          !['local','jamendo'].includes(item.provider) || typeof item.grant !== 'string' || !item.grant.trim() ||
          !Number.isFinite(Date.parse(item.validUntil)) || (item.provider === 'jamendo' && !/^[1-9]\d*$/.test(item.id))) {
        throw Error('Invalid or duplicate manifest entry');
      }
      seen.add(item.id);
      if (Date.parse(item.validUntil) > Date.now()) allowed.set(item.id, { ...item, revision: digest(JSON.stringify(item)) });
    }
    const inventory = await (await cloud('/internal/inventory')).json();
    const known = new Map();
    const budget = [inventory.maxBytes, inventory.bytes, inventory.count].join('/');
    for (const [id, denied] of noSpace) {
      if (allowed.get(id)?.revision !== denied.revision || budget !== denied.budget) noSpace.delete(id);
    }
    for (const row of inventory.tracks) {
      if (!allowed.has(row.id)) await (await cloud('/internal/tracks/' + row.id, { method: 'DELETE' })).arrayBuffer();
      else known.set(row.id, row);
    }
    const changed = [...allowed.values()].filter(e => known.has(e.id) && known.get(e.id).revision !== e.revision);
    const fresh = [...allowed.values()].filter(e => !known.has(e.id) && !noSpace.has(e.id));
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    const oldest = [...known.values()].find(row => !row.inUse && Date.now() - row.added > 86400000);
    const rotating = known.size >= inventory.target && oldest && fresh.length;
    const need = rotating ? 1 : Math.max(0, inventory.target - known.size);
    let uploaded = 0, failed = 0;
    for (const entry of [...changed, ...fresh.slice(0, need)].slice(0, 6)) {
      try {
        await prepare(entry, rotating && !known.has(entry.id) ? oldest.id : null);
        uploaded++;
      } catch (error) {
        console.warn('Track preparation failed:', entry.id, error.message);
        if (error.status === 507) noSpace.set(entry.id, { revision: entry.revision, budget });
        failed++;
      }
    }
    const pending = inventory.pendingCountry;
    if (clientId && pending && allowed.get(pending.id)?.revision === pending.revision) {
      const location = await lookupJamendoCountry(pending.artist, pending.artistId, { clientId, countries, fetchJson: musicJson });
      const countrycode = location.code || '';
      const body = JSON.stringify({ revision: pending.revision, countrycode, country: countrycode ? names.of(countrycode) : '未知地区' });
      await (await cloud('/internal/tracks/' + pending.id, { method: 'PATCH', body })).arrayBuffer();
    }
    if (failed) throw Error('Published ' + uploaded + ' tracks, failed ' + failed);
    return uploaded;
  };
}

async function main() {
  const run = createPreparer({ endpoint: process.env.VINYL_DISTRIBUTOR_URL, token: process.env.VINYL_UPLOAD_TOKEN,
    manifest: process.env.VINYL_MANIFEST, clientId: process.env.JAMENDO_CLIENT_ID });
  const once = process.argv.includes('--once');
  const interval = integer(process.env.VINYL_POLL_MS, 30000, 1000, 3600000);
  let failures = 0;
  do {
    try { console.log('Published tracks:', await run()); failures = 0; }
    catch (error) {
      if (once) throw error;
      console.error('Preparation failed:', error.message); failures = Math.min(failures + 1, 6);
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, Math.min(600000, interval * 2 ** failures)));
  } while (!once);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createPreparer };
