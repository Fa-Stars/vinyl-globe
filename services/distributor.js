'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { timingSafeEqual } = require('node:crypto');
const { version } = require('../package.json');
const { openLibrary } = require('./library');
const { createSessions } = require('./cloud-sessions');
const { AUDIO_LIMIT, COVER_LIMIT, ID, digest, fault, integer, readLimited, validTrack } = require('./protocol');

const assets = {
  'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css', 'map.json': 'application/json', 'capitals.json': 'application/json',
  'record-sleeve.svg': 'image/svg+xml',
};
const publicDir = path.resolve(__dirname, '../web/public');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function byteRange(value, size) {
  if (!value) return [0, size - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !(match[1] || match[2])) return null;
  const first = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const last = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last && first < size ? [first, last] : null;
}

function createDistributor({ directory, token, target = 72, maxBytes = 5 * 1024 ** 3 }) {
  if (!directory || !token || token.length < 24) throw new Error('Set VINYL_LIBRARY_DIR and an upload token of at least 24 characters');
  const expected = Buffer.from('Bearer ' + token);
  const library = openLibrary(directory, { maxBytes, maxTracks: target * 2 });
  const sessions = createSessions(library);
  const readers = new Map();
  let uploading = false;
  const timer = setInterval(() => { library.expire(); sessions.expire(); }, 60000);
  timer.unref();

  function publicSong(id) {
    const row = library.find(id);
    if (!row) throw fault(404, 'TRACK_UNAVAILABLE');
    const m = JSON.parse(row.meta);
    return { id, title: m.title, artist: m.artist, album: m.album, duration: m.duration,
      country: m.country, countrycode: m.countrycode, countryStatus: m.countrycode ? 'resolved' : 'none',
      sourceUrl: m.sourceUrl, license: m.license, streamUrl: '/audio/' + id,
      audioType: m.audioType, audioHash: m.audioHash,
      artwork: row.coverSize ? '/artwork/' + id : '' };
  }

  async function upload(req, res, id, replace) {
    if (uploading) throw fault(429, 'Another upload is active');
    uploading = true;
    try {
      const body = await readLimited(req, AUDIO_LIMIT + COVER_LIMIT + 32768);
      let form, track;
      try {
        form = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] || '' } }).formData();
        const meta = form.get('metadata');
        if (typeof meta !== 'string' || Buffer.byteLength(meta) > 8192) throw Error();
        track = JSON.parse(meta);
      } catch { throw fault(400, 'Malformed upload'); }
      validTrack(track);
      const file = form.get('audio'), image = form.get('cover');
      if (track.id !== id || !file?.size || file.size > AUDIO_LIMIT || file.type !== track.audioType ||
          (image ? !image.size || image.size > COVER_LIMIT || image.type !== track.coverType : track.coverType)) {
        throw fault(400, 'Invalid media');
      }
      const audio = Buffer.from(await file.arrayBuffer());
      const cover = image ? Buffer.from(await image.arrayBuffer()) : Buffer.alloc(0);
      if (digest(audio) !== track.audioHash || digest(cover) !== track.coverHash) throw fault(422, 'Checksum mismatch');
      const pinned = new Set([...sessions.pinned(), ...readers.keys()]);
      const created = library.put(track, audio, cover, track.audioHash + ':' + track.coverHash, pinned, replace);
      json(res, created ? 201 : 200, { id, audioHash: track.audioHash });
    } finally { uploading = false; }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost'), route = url.pathname, method = req.method;
    if (route.startsWith('/internal/')) {
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fault(401, 'Unauthorized');
      if (method === 'GET' && route === '/internal/inventory') {
        library.expire();
        const pinned = sessions.pinned();
        return json(res, 200, { tracks: library.list().map(row => ({ ...row, inUse: pinned.has(row.id) || readers.has(row.id) })),
          pendingCountry: library.pendingCountry(), target, maxBytes, ...library.usage() });
      }
      const id = route.slice('/internal/tracks/'.length);
      if (route.startsWith('/internal/tracks/') && ID.test(id)) {
        if (method === 'PUT') return upload(req, res, id, url.searchParams.get('replace'));
        if (method === 'PATCH') {
          let update;
          try { update = JSON.parse(await readLimited(req, 2048)); } catch { throw fault(400, 'Invalid country update'); }
          if (!update || typeof update.revision !== 'string' || typeof update.countrycode !== 'string' ||
              !/^(?:[A-Z]{2})?$/.test(update.countrycode) || typeof update.country !== 'string') throw fault(400, 'Invalid country update');
          if (!library.updateCountry(id, update.revision, update.countrycode, update.country).changes) throw fault(409, 'Track changed');
          res.writeHead(204); return res.end();
        }
        if (method === 'DELETE') {
          if (url.searchParams.has('idle') && (sessions.pinned().has(id) || readers.has(id))) throw fault(409, 'Track in use');
          library.remove(id); res.writeHead(204); return res.end();
        }
      }
      throw fault(404, 'Unknown internal endpoint');
    }
    const token = req.headers['x-vinyl-session'];
    if (route === '/api/listening-session' && method === 'POST') {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fault(403, 'Invalid origin');
      const raw = await readLimited(req, 2048);
      let data;
      try { data = raw.length ? JSON.parse(raw) : {}; } catch { throw fault(400, 'Invalid session body'); }
      if (!data || typeof data !== 'object') throw fault(400, 'Invalid session body');
      const key = token || data.token;
      if (!key) return json(res, 200, sessions.open());
      sessions.get(key);
      if (data.state === 'disconnect') sessions.close(key);
      res.writeHead(204); return res.end();
    }
    if (route === '/api/client-session' || (route === '/api/audio/played' && method === 'POST')) {
      res.writeHead(204); return res.end();
    }
    if (!['HEAD', 'GET'].includes(method)) throw fault(405, 'Unsupported method');
    if (route === '/api/info') {
      const count = library.playableIds().length;
      return json(res, 200, { mode: 'distribution', version, configured: true, serverMode: true,
        personalQueues: true, songs: count, buffer: { ready: count, target, sessions: sessions.count(), perSessionTarget: sessions.target } });
    }
    if (route.startsWith('/api/') && method !== 'GET') throw fault(405, 'GET required');
    if (route === '/api/queue') return json(res, 200, { tracks: sessions.fill(sessions.get(token)).map(publicSong) });
    if (route === '/api/song') {
      const start = performance.now();
      if (!token) throw fault(401, 'SESSION_EXPIRED');
      const session = sessions.get(token);
      const id = sessions.take(session, Number(req.headers['x-vinyl-sequence']));
      const song = publicSong(id);
      const head = session.queue[0];
      const row = head && library.find(head);
      if (row) {
        const meta = JSON.parse(row.meta);
        song.upNext = { id: head, streamUrl: '/audio/' + head, audioType: meta.audioType, audioHash: meta.audioHash };
      }
      res.setHeader('Server-Timing', 'song;dur=' + (performance.now() - start).toFixed(2));
      return json(res, 200, song);
    }
    if (route === '/api/country') {
      const song = publicSong(url.searchParams.get('id') || '');
      return json(res, 200, { id: song.id, country: song.country, countrycode: song.countrycode, status: song.countryStatus });
    }
    const media = /^\/(audio|artwork)\/([A-Za-z0-9_-]+)$/.exec(route);
    if (media) {
      const id = media[2], type = media[1] === 'audio' ? 'audio' : 'cover';
      const row = library.find(id);
      const size = row && (type === 'audio' ? row.size : row.coverSize);
      if (!size) throw fault(404, 'Media unavailable');
      const range = byteRange(req.headers.range, size);
      if (!range) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      const [first, last] = range, meta = JSON.parse(row.meta);
      res.writeHead(req.headers.range ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
        'Content-Type': type === 'audio' ? meta.audioType : meta.coverType, 'Content-Length': last - first + 1,
        ...(req.headers.range ? { 'Content-Range': 'bytes ' + first + '-' + last + '/' + size } : {}) });
      if (method === 'HEAD') return res.end();
      readers.set(id, (readers.get(id) || 0) + 1);
      try {
        function* chunks() {
          for (let pos = first; pos <= last; pos += 65536) {
            const chunk = library.read(type, id, pos, Math.min(65536, last - pos + 1));
            if (!chunk?.length) throw Error('Media withdrawn');
            yield chunk;
          }
        }
        await pipeline(Readable.from(chunks(), { objectMode: false }), res);
      } finally {
        const remaining = readers.get(id) - 1;
        if (remaining) readers.set(id, remaining); else readers.delete(id);
      }
      return;
    }
    const name = route === '/' ? 'index.html' : route.slice(1);
    if (!Object.hasOwn(assets, name)) throw fault(404, 'Not found');
    res.setHeader('Content-Type', assets[name]);
    if (method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(path.join(publicDir, name)), res);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      const status = error.status || 500;
      if (status === 500) console.error(error.message);
      const message = status === 500 ? 'Internal error' : error.message;
      json(res, status, { code: message, error: message });
    });
  });
  server.on('close', () => { clearInterval(timer); library.close(); });
  return server;
}

if (require.main === module) {
  const server = createDistributor({ directory: process.env.VINYL_LIBRARY_DIR, token: process.env.VINYL_UPLOAD_TOKEN,
    target: integer(process.env.VINYL_TARGET, 72, 6, 1000),
    maxBytes: integer(process.env.VINYL_MAX_BYTES, 5 * 1024 ** 3, 1024, 2 ** 40) });
  server.listen(integer(process.env.PORT, 3100, 0, 65535), process.env.WORLD_VINYL_HOST || '127.0.0.1',
    () => console.log('World Vinyl distributor listening on port ' + server.address().port));
}
module.exports = { createDistributor };
