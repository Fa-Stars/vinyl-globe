'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/';

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
    if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
    const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
    return reply(res, ids.map(id => track(id)));
  }
  if (route === '/v3.0/artists/locations/') return reply(res, []);
  res.writeHead(404);
  res.end();
}

test('prepares two tracks serially and serves both from cache during rapid skips', async t => {
  const downloaded = [];
  let active = 0;
  let peakActive = 0;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return tracksApi(req, res);
      if (route && route.startsWith('/audio/')) {
        downloaded.push(route.slice('/audio/'.length));
        active++;
        peakActive = Math.max(peakActive, active);
        res.once('close', () => { active--; });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        // Keep replenishment pending so rapid skips must use the first two.
        if (downloaded.length > 2) return res.write('pending');
        return res.end('cached-audio');
      }
      res.writeHead(404);
      res.end();
    },
  });
  await backend.waitForOutput(/\[audio\] cached \d+ \([^\n]*ready=2\)/);
  assert.equal(downloaded.length, 2);
  const prepared = downloaded.slice();
  const selected = [];
  for (let i = 0; i < 2; i++) {
    const response = await backend.request('/api/song');
    assert.equal(response.status, 200);
    const song = await response.json();
    selected.push(song.id);
    assert.equal(song.streamUrl, '/audio/' + song.id);
    const audio = await backend.request(song.streamUrl);
    assert.equal(await audio.text(), 'cached-audio');
  }
  assert.deepEqual(selected.sort(), prepared.sort());
  for (const id of prepared) assert.equal(downloaded.filter(value => value === id).length, 1);
  assert.equal(peakActive, 1, 'warm downloads should remain serial');
});

test('does not queue a second warm download for an audio request already warming', async t => {
  const upstreamHits = new Map();
  let warmingId;
  let warmingStarted;
  const warmingStartedPromise = new Promise(resolve => { warmingStarted = resolve; });
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return tracksApi(req, res);
      if (route && route.startsWith('/audio/')) {
        const id = route.slice('/audio/'.length);
        warmingId ||= id;
        upstreamHits.set(id, (upstreamHits.get(id) || 0) + 1);
        warmingStarted();
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.write('audio-start');
        return setTimeout(() => res.end('-audio-end'), 250);
      }
      res.writeHead(404);
      res.end();
    },
  });
  await warmingStartedPromise;
  assert.ok(warmingId, 'startup should warm a live candidate');
  const response = await backend.request('/audio/' + warmingId);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'audio-start-audio-end');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(upstreamHits.get(warmingId), 2);
});

test('returns a cold Jamendo track before the full warm download finishes', async t => {
  let slowId;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return tracksApi(req, res);
      if (route && route.startsWith('/audio/')) {
        slowId ||= route.slice('/audio/'.length);
        started();
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.write('audio-start');
        return setTimeout(() => res.end('-audio-end'), 900);
      }
      res.writeHead(404);
      res.end();
    },
  });
  await startedPromise;
  const before = performance.now();
  const response = await backend.request('/api/song');
  const song = await response.json();
  const elapsed = Math.round(performance.now() - before);
  t.diagnostic('cold live track metadata: ' + elapsed + 'ms');
  assert.equal(response.status, 200);
  assert.ok(song.id);
  assert.ok(elapsed < 700, 'metadata waited for the full download: ' + elapsed + 'ms');
});

test('played audio cleanup removes the file but keeps the live source usable', async t => {
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return tracksApi(req, res);
      if (route && route.startsWith('/audio/')) return res.end('cached-audio');
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  await backend.waitForOutput(new RegExp('\\[audio\\] cached ' + song.id + '\\b'));
  assert.equal(backend.exists('audio/' + song.id + '.mp3'), true);
  const result = await backend.request('/api/audio/played?id=' + song.id, { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).ok, true);
  assert.equal(backend.exists('audio/' + song.id + '.mp3'), false);
  assert.equal(backend.exists('audio/' + song.id + '.mp3.tmp'), false);
  // URL metadata is process-local and remains available for a direct stream.
  const stream = await backend.request('/audio/' + song.id);
  assert.equal(stream.status, 200);
  assert.equal(await stream.text(), 'cached-audio');
  assert.equal(backend.exists('jamendo/pool.json'), false);
  assert.equal(backend.exists('audio/_urls.json'), false);
});
