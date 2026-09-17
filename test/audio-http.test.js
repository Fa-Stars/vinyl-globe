'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/';

function track(id, extra = {}) {
  return {
    id: String(id),
    name: 'Fixture ' + id,
    artist_id: 'artist-' + id,
    artist_name: 'Fixture Artist ' + id,
    album_name: 'Fixture Album',
    audio: 'https://api.jamendo.com/audio/' + id,
    duration: 10,
    license_ccurl: LICENSE,
    ...extra,
  };
}

function reply(res, results, extra = {}) {
  res.end(JSON.stringify({ headers: { status: 'success', ...extra }, results }));
}

function liveUpstream(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const route = u.searchParams.get('path');
  if (route === '/v3.0/tracks/') {
    if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
    const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
    return reply(res, ids.map(id => track(id)));
  }
  if (route === '/v3.0/artists/locations/') return reply(res, []);
  if (route && route.startsWith('/audio/')) {
    res.writeHead(503);
    return res.end();
  }
  res.writeHead(404);
  res.end();
}

async function registerSong(t, options = {}) {
  const backend = await startBackend(t, { upstream: liveUpstream, ...options });
  const response = await backend.request('/api/song');
  if (response.status !== 200) throw new Error('song request failed: ' + response.status + ' ' + await response.text());
  return { backend, song: await response.json() };
}

test('audio suffix Range returns the last bytes of a live registered cached file', async (t) => {
  const { backend, song } = await registerSong(t);
  backend.write('audio/' + song.id + '.mp3', '0123456789');
  const response = await backend.request('/audio/' + song.id, { headers: { Range: 'bytes=-4' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 6-9/10');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '6789');
});

test('malformed and unknown audio paths are rejected without stopping the server', async (t) => {
  const { backend } = await registerSong(t);
  for (const pathname of ['/audio/%', '/audio/%E0%A4', '/audio/%2e%2e%2fsecret', '/audio/toString']) {
    const response = await backend.request(pathname);
    assert.ok([400, 404].includes(response.status), pathname + ': ' + response.status);
    await response.text();
    assert.equal((await backend.request('/api/info')).status, 200);
  }
});

test('cached audio handles open, clamped and unsatisfiable ranges', async (t) => {
  const { backend, song } = await registerSong(t);
  backend.write('audio/' + song.id + '.mp3', '0123456789');
  for (const [range, status, contentRange, body] of [
    ['bytes=3-', 206, 'bytes 3-9/10', '3456789'],
    ['bytes=7-999', 206, 'bytes 7-9/10', '789'],
    ['bytes=-99', 206, 'bytes 0-9/10', '0123456789'],
    ['bytes=10-', 416, 'bytes */10', ''],
    ['bytes=8-2', 416, 'bytes */10', ''],
    ['bytes=-0', 416, 'bytes */10', ''],
    ['bytes=-', 416, 'bytes */10', ''],
    ['bytes=9007199254740992-', 416, 'bytes */10', ''],
  ]) {
    const response = await backend.request('/audio/' + song.id, { headers: { Range: range } });
    assert.equal(response.status, status, range);
    assert.equal(response.headers.get('content-range'), contentRange, range);
    assert.equal(response.headers.get('cache-control'), 'no-store', range);
    assert.equal(await response.text(), body, range);
  }
  const head = await backend.request('/audio/' + song.id, { method: 'HEAD', headers: { Range: 'bytes=3-' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(await head.text(), '');
});

test('a cache write failure does not interrupt streaming or crash the backend', async (t) => {
  let audioPath;
  let audioEnabled = false;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        const id = (u.searchParams.get('id') || '').split('+')[0] || '420001';
        return reply(res, [track(id, { audio: 'https://api.jamendo.com/audio-fixture' })]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route === '/audio-fixture') {
        if (!audioEnabled) {
          res.writeHead(503);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.write('complete-');
        return setTimeout(() => res.end('audio'), 50);
      }
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  audioPath = path.join(backend.root, 'audio', song.id + '.mp3.tmp');
  fs.mkdirSync(audioPath, { recursive: true });
  audioEnabled = true;
  const response = await backend.request('/audio/' + song.id);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'complete-audio');
  assert.equal((await backend.request('/api/info')).status, 200);
  assert.equal(fs.existsSync(audioPath), true);
});

test('uncached audio forwards Range responses and survives an interrupted upstream', async (t) => {
  let songId;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        songId = (u.searchParams.get('id') || '').split('+')[0];
        return reply(res, [track(songId)]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) {
        if (req.headers.range === 'bytes=3-5') {
          res.writeHead(206, { 'Content-Range': 'bytes 3-5/10', 'Content-Length': '3', 'Accept-Ranges': 'bytes' });
          return res.end('345');
        }
        res.writeHead(200, { 'Content-Length': '10' });
        res.write('012');
        return setTimeout(() => res.destroy(), 50);
      }
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  const partial = await backend.request('/audio/' + song.id, { headers: { Range: 'bytes=3-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 3-5/10');
  assert.equal(partial.headers.get('cache-control'), 'no-store');
  assert.equal(await partial.text(), '345');
  await assert.rejects(async () => (await backend.request('/audio/' + song.id)).text());
  assert.equal((await backend.request('/api/info')).status, 200);
});

test('cancelling an audio response closes its upstream without stopping the server', { timeout: 5000 }, async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  let songId;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        songId = (u.searchParams.get('id') || '').split('+')[0];
        return reply(res, [track(songId)]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/') && req.headers.range) {
        res.on('close', closed);
        res.writeHead(206, { 'Content-Range': 'bytes 0-999999/1000000' });
        return res.write('begin');
      }
      res.writeHead(503);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  const response = await backend.request('/audio/' + song.id, { headers: { Range: 'bytes=0-' } });
  await response.body.cancel();
  await disconnected;
  assert.equal((await backend.request('/api/info')).status, 200);
});
