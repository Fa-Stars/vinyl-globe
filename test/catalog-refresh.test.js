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

test('Jamendo keeps serving the working live catalog while a refresh is pending or fails', async (t) => {
  let failRefresh;
  let initial = true;
  let failed = false;
  let refreshStarted;
  const requestStarted = new Promise((resolve) => { refreshStarted = resolve; });
  const backend = await startBackend(t, {
    catalogMaxId: 8,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '8' }]);
        const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
        if (initial) {
          initial = false;
          return reply(res, ids.map(id => track(id, { name: 'Old ' + id })));
        }
        if (failed) {
          res.writeHead(503);
          return res.end();
        }
        refreshStarted();
        failRefresh = () => {
          failed = true;
          res.writeHead(503);
          res.end();
        };
        return;
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) return res.end('live audio');
      res.writeHead(404);
      res.end();
    },
  });
  // The first request registers six live candidates. Consume one so forced
  // refresh has work to do while the five remaining candidates stay usable.
  const first = await (await backend.request('/api/song')).json();
  await backend.triggerRefresh();
  await requestStarted;
  const during = await backend.request('/api/song');
  assert.equal(during.status, 200);
  const duringSong = await during.json();
  assert.notEqual(duringSong.id, first.id);
  failRefresh();
  await backend.waitForOutput(/pool refresh failed/);
  const after = await backend.request('/api/song');
  assert.equal(after.status, 200);
  assert.notEqual((await after.json()).id, duringSong.id);
  assert.equal(await (await backend.request('/audio/' + first.id)).text(), 'live audio');
});

test('Jamendo mode rejects country filters instead of falling back to iTunes', async (t) => {
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('path') === '/v3.0/tracks/') return reply(res, [{ id: '1' }]);
      res.writeHead(404);
      res.end();
    },
  });
  const response = await backend.request('/api/song?country=US');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: 'COUNTRY_FILTER_UNSUPPORTED',
    error: 'Jamendo 模式不支持按国家筛选',
  });
  assert.doesNotMatch(backend.output, /iTunes/i);
});

test('a cold Jamendo startup can retry after the upstream recovers', async (t) => {
  let available = false;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      if (!available) {
        res.writeHead(503);
        return res.end();
      }
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '1' }]);
        const id = (u.searchParams.get('id') || '').split('+')[0] || '1';
        return reply(res, [track(id, { name: 'Fresh Track' })]);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) return res.end('audio');
      res.writeHead(404);
      res.end();
    },
  });
  await backend.waitForOutput(/pool fetch failed/);
  available = true;
  const response = await backend.request('/api/song');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, 'Fresh Track');
});

test('an empty refresh cannot restore a consumed candidate from the session', async t => {
  let firstBatch = true;
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '1' }]);
        if (firstBatch) {
          firstBatch = false;
          return reply(res, [track('1', { name: 'Existing Track' })]);
        }
        return reply(res, []);
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) return res.end('existing audio');
      res.writeHead(404);
      res.end();
    },
  });
  const first = await (await backend.request('/api/song')).json();
  assert.equal(first.id, '1');
  await backend.triggerRefresh();
  await backend.waitForOutput(/pool refresh failed/);
  const response = await backend.request('/api/song');
  assert.equal(response.status, 503);
  // Metadata history remains available for a paused current song, but cannot
  // become another pending candidate or restore an offline playlist.
  assert.equal((await backend.request('/api/info').then(r => r.json())).songs, 1);
});
