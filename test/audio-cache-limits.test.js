'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/';
const FILE_LIMIT = 16 * 1024 * 1024;
const TOTAL_LIMIT = 48 * 1024 * 1024;
const TTL = 15 * 60 * 1000;

function track(id, extra = {}) {
  return {
    id: String(id),
    name: 'Track ' + id,
    artist_id: 'artist-' + id,
    artist_name: 'Artist ' + id,
    audio: 'https://api.jamendo.com/audio/' + id,
    duration: 180,
    license_ccurl: LICENSE,
    ...extra,
  };
}

function reply(res, results, extra = {}) {
  res.end(JSON.stringify({ headers: { status: 'success', ...extra }, results }));
}

function tracksApi(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const route = u.searchParams.get('path');
  if (route === '/v3.0/tracks/') {
    if (u.searchParams.get('order')) return reply(res, [{ id: '4' }]);
    const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
    return reply(res, ids.map(id => track(id)));
  }
  if (route === '/v3.0/artists/locations/') return reply(res, []);
  res.writeHead(404);
  res.end();
}

function writeChunked(res, total, contentType = 'audio/mpeg') {
  res.writeHead(200, { 'Content-Type': contentType });
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  let sent = 0;
  function pump() {
    while (sent < total) {
      const next = Math.min(chunk.length, total - sent);
      const writable = res.write(next === chunk.length ? chunk : chunk.subarray(0, next));
      sent += next;
      if (!writable) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
  }
  pump();
}

function listAudioFiles(root) {
  if (!fs.existsSync(path.join(root, 'audio'))) return [];
  return fs.readdirSync(path.join(root, 'audio')).filter(name => /\.mp3(?:\.tmp)?$/.test(name));
}

async function waitForCacheCount(backend, expected) {
  const deadline = Date.now() + 8000;
  while ((backend.output.match(/\[audio\] cached /g) || []).length < expected) {
    if (Date.now() > deadline) throw new Error('Expected ' + expected + ' completed warm downloads\n' + backend.output);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('a chunked file over 16 MiB is streamed but leaves no partial cache or temp file', { timeout: 30000 }, async t => {
  let id;
  const total = FILE_LIMIT + 1;
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '1' }]);
        id = (u.searchParams.get('id') || '').split('+')[0] || '1';
        return reply(res, [track(id)]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route === '/audio/' + id) return writeChunked(res, total);
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  const response = await backend.request('/audio/' + song.id);
  assert.equal(response.status, 200);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, total);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(backend.exists('audio/' + song.id + '.mp3'), false);
  assert.equal(backend.exists('audio/' + song.id + '.mp3.tmp'), false);
});

test('complete audio cache is capped at three files and 48 MiB', { timeout: 30000 }, async t => {
  const bytes = Buffer.alloc(1024, 0x62);
  const backend = await startBackend(t, {
    catalogMaxId: 4,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return tracksApi(req, res);
      if (route && route.startsWith('/audio/')) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) });
        return res.end(bytes);
      }
      res.writeHead(404);
      res.end();
    },
  });
  for (let i = 0; i < 4; i++) {
    await waitForCacheCount(backend, i + 1);
    const response = await backend.request('/api/song');
    assert.equal(response.status, 200);
    await response.json();
  }
  const files = listAudioFiles(backend.root).filter(name => name.endsWith('.mp3'));
  const bytesOnDisk = files.reduce((sum, name) => sum + fs.statSync(path.join(backend.root, 'audio', name)).size, 0);
  assert.ok(files.length <= 3, 'cached files: ' + files.join(', '));
  assert.ok(bytesOnDisk <= TOTAL_LIMIT, 'cached bytes: ' + bytesOnDisk);
  assert.equal(files.some(name => name.endsWith('.tmp')), false);
});

test('an expired cached Range falls through to the live stream and is marked no-store', async t => {
  const start = Date.now();
  let id;
  let audioRequests = 0;
  const backend = await startBackend(t, {
    now: start,
    catalogMaxId: 1,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '1' }]);
        id = '1';
        return reply(res, [track(id)]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route === '/audio/' + id) {
        audioRequests++;
        if (audioRequests === 1) return res.end('cached-audio');
        res.writeHead(206, { 'Content-Range': 'bytes 0-10/11', 'Content-Length': '11', 'Accept-Ranges': 'bytes' });
        return res.end('fresh-audio');
      }
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  await backend.waitForOutput(new RegExp('\\[audio\\] cached ' + song.id + '\\b'));
  assert.equal(backend.exists('audio/' + song.id + '.mp3'), true);
  await backend.setClock(start + TTL + 5000);
  const response = await backend.request('/audio/' + song.id, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'fresh-audio');
  assert.ok(audioRequests >= 2, 'expired cache should request the source again');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(backend.exists('audio/' + song.id + '.mp3.tmp'), false);
});
