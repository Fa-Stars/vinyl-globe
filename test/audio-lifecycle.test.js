'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
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

async function waitUntil(predicate, diagnostic = () => '') {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Expected lifecycle event did not occur\n' + diagnostic());
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('releasing a warming track cancels its upstream and frees the single download slot', async t => {
  const opened = new Set();
  const closed = new Set();
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
        return reply(res, ids.map(id => track(id)));
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) {
        const id = route.slice('/audio/'.length);
        opened.add(id);
        res.on('close', () => closed.add(id));
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        return res.write('partial audio'); // Deliberately leave the warm slot occupied.
      }
      res.writeHead(404);
      res.end();
    },
  });
  await waitUntil(() => opened.size === 1, () => backend.output);
  const id = [...opened][0];
  const result = await backend.request('/api/audio/played?id=' + id, { method: 'POST' });
  assert.equal(result.status, 200);
  await waitUntil(() => closed.has(id) && opened.size >= 2);
  await waitUntil(() => !backend.exists('audio/' + id + '.mp3.tmp'));
  assert.equal(backend.exists('audio/' + id + '.mp3'), false);
});

test('a failed warm request does not repeatedly retry an idle candidate', async t => {
  let audioRequests = 0;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        return reply(res, (u.searchParams.get('id') || '').split('+').filter(Boolean).map(id => track(id)));
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) audioRequests++;
      res.writeHead(503);
      res.end();
    },
  });
  await waitUntil(() => audioRequests === 2, () => backend.output);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(audioRequests, 2);
});

test('a cancelled song request leaves every pending candidate available', { timeout: 8000 }, async t => {
  let pending;
  let released = false;
  let requests = 0;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        if (u.searchParams.get('order')) return reply(res, [{ id: '800000' }]);
        const requested = (u.searchParams.get('id') || '').split('+').filter(Boolean);
        requests++;
        // Keep the first live discovery response pending while the client leaves.
        if (!pending) {
          pending = { res, requested };
          return;
        }
        if (released) return reply(res, []);
        return reply(res, requested.map(id => track(id)));
      }
      if (route === '/v3.0/artists/locations/') return reply(res, []);
      if (route && route.startsWith('/audio/')) return res.end('audio');
      res.writeHead(404);
      res.end();
    },
  });
  await waitUntil(() => pending);
  const probe = http.get('http://127.0.0.1:' + backend.port + '/api/song');
  probe.on('error', () => {});
  await new Promise(resolve => probe.once('finish', resolve));
  await backend.waitForOutput(/\[test\] song request opened/);
  const closed = new Promise(resolve => probe.once('close', resolve));
  probe.destroy();
  await closed;
  await backend.waitForOutput(/\[test\] song request closed/);

  // Finish discovery after the browser has left. None of these six candidates
  // may have been consumed by the abandoned HTTP response.
  pending.res.end(JSON.stringify({
    headers: { status: 'success' },
    results: pending.requested.map(id => track(id)),
  }));
  released = true;
  await waitUntil(() => requests >= 1);

  const delivered = new Set();
  for (let i = 0; i < 6; i++) {
    const response = await backend.request('/api/song');
    if (response.status !== 200) throw new Error('song request failed: ' + response.status + ' ' + await response.text());
    delivered.add((await response.json()).id);
  }
  assert.equal(delivered.size, 6);
  assert.ok([...delivered].every(id => pending.requested.includes(id)));
});
