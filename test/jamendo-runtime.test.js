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

function liveTracks(req, res, { maxId = '800000', result = id => track(id) } = {}) {
  const u = new URL(req.url, 'http://localhost');
  const route = u.searchParams.get('path');
  if (route === '/v3.0/tracks/') {
    if (u.searchParams.get('order')) return reply(res, [{ id: maxId }]);
    const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
    return reply(res, ids.map(result).filter(Boolean));
  }
  if (route === '/v3.0/artists/locations/') return reply(res, []);
  res.writeHead(404);
  res.end();
}

test('missing Jamendo credentials is setup-required and makes no upstream request', async t => {
  let requests = 0;
  const backend = await startBackend(t, {
    credentials: false,
    upstream(_req, res) {
      requests++;
      res.writeHead(500);
      res.end();
    },
  });
  const info = await backend.request('/api/info');
  assert.equal(info.status, 200);
  const details = await info.json();
  assert.equal(details.mode, 'setup-required');
  assert.equal(details.configured, false);
  const response = await backend.request('/api/song');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'JAMENDO_SETUP_REQUIRED');
  assert.equal(requests, 0);
});

test('startup purges runtime song and audio directories while preserving configuration, bounds and artist evidence', async t => {
  const config = JSON.stringify({ jamendoClientId: 'keep-me', theme: 'pixel' });
  const bounds = JSON.stringify({ maxId: 123456, checkedAt: Date.now() });
  const artists = JSON.stringify({ Artist: {
    code: 'JP', country: '日本', source: 'jamendo', sourceUrl: 'https://www.jamendo.com/artist/123001',
    artistId: 'artist-123001', resolverVersion: 9, ts: Date.now(),
  } });
  const backend = await startBackend(t, {
    credentials: false,
    setup(root) {
      fs.writeFileSync(path.join(root, 'config.json'), config);
      fs.writeFileSync(path.join(root, 'catalog-bounds.json'), bounds);
      fs.writeFileSync(path.join(root, 'artist-countries.json'), artists);
      fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
      fs.mkdirSync(path.join(root, 'jamendo'), { recursive: true });
      fs.mkdirSync(path.join(root, 'songs'), { recursive: true });
      fs.writeFileSync(path.join(root, 'audio', '123001.mp3'), 'old audio');
      fs.writeFileSync(path.join(root, 'audio', '_urls.json'), '{}');
      fs.writeFileSync(path.join(root, 'jamendo', 'pool.json'), JSON.stringify([track('123001')]));
      fs.writeFileSync(path.join(root, 'songs', 'US.json'), 'old chart');
    },
  });
  // startBackend always disables exit cleanup; these assertions therefore prove
  // that startup, rather than shutdown, removed the stale runtime state.
  assert.equal(backend.exists('audio/123001.mp3'), false);
  assert.equal(backend.exists('audio/_urls.json'), false);
  assert.equal(backend.exists('jamendo/pool.json'), false);
  assert.equal(backend.exists('songs/US.json'), false);
  assert.equal(backend.read('config.json'), config);
  assert.equal(backend.read('catalog-bounds.json'), bounds);
  assert.equal(backend.read('artist-countries.json'), artists);
});

test('a saved pool cannot restore an offline song after startup purge', async t => {
  const stale = track('990001', { name: 'Stale Offline Track' });
  const backend = await startBackend(t, {
    pool: [stale],
    audio: { [stale.id]: 'stale audio' },
    upstream(_req, res) {
      res.writeHead(503);
      res.end();
    },
  });
  assert.equal(backend.exists('jamendo/pool.json'), false);
  assert.equal(backend.exists('audio/' + stale.id + '.mp3'), false);
  const response = await backend.request('/api/song');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.notEqual(body.id, stale.id);
});

test('tracks without a recognized CC license are filtered before discovery counting', async t => {
  const backend = await startBackend(t, {
    catalogMaxId: 3,
    upstream(req, res) {
      liveTracks(req, res, {
        maxId: '3',
        result(id) {
          if (id === '1') return track(id, { license_ccurl: '' });
          if (id === '2') return track(id, { license_ccurl: 'https://evil.example/licenses/by/4.0/' });
          if (id === '3') return track(id, { name: 'Licensed Track' });
          return null;
        },
      });
    },
  });
  const response = await backend.request('/api/song');
  assert.equal(response.status, 200);
  const song = await response.json();
  assert.equal(song.id, '3');
  assert.equal(song.title, 'Licensed Track');
  assert.deepEqual(song.license, { name: 'CC BY-NC-SA 3.0', url: LICENSE });
  assert.equal(song.sourceUrl, 'https://www.jamendo.com/track/3');
  const info = await (await backend.request('/api/info')).json();
  assert.equal(info.songs, 1);
  assert.equal(backend.exists('jamendo/pool.json'), false);
  assert.equal(backend.exists('audio/_urls.json'), false);
});

test('unknown audio sources are rejected without opening a remote stream', async t => {
  const audioPaths = [];
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/' || route === '/v3.0/artists/locations/') return liveTracks(req, res);
      if (route && route.startsWith('/audio/')) {
        audioPaths.push(route);
        return res.end('unexpected remote audio');
      }
      res.writeHead(404);
      res.end();
    },
  });
  const song = await (await backend.request('/api/song')).json();
  const response = await backend.request('/audio/999999999');
  assert.equal(response.status, 404);
  await response.text();
  assert.equal(audioPaths.includes('/audio/999999999'), false);
  assert.equal((await backend.request('/api/info')).status, 200);
  assert.match(song.sourceUrl, /^https:\/\/www\.jamendo\.com\/track\/\d+$/);
});
