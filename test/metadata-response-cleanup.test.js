'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const LICENSE = 'https://creativecommons.org/licenses/by/4.0/';
const reply = (res, results) => res.end(JSON.stringify({ headers: { status: 'success' }, results }));

async function waitForClosed(expected, closed) {
  const deadline = Date.now() + 1500;
  while (closed() < expected()) {
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.ok(expected() > 0, 'the upstream should have received an error response request');
  assert.equal(closed(), expected(), 'error response bodies must close before their long network timeout');
}

for (const status of [400, 404, 503]) {
  test('Jamendo HTTP ' + status + ' releases its unfinished body and keeps existing songs usable', async t => {
    let initial = true;
    let opened = 0;
    let closed = 0;
    const backend = await startBackend(t, {
      catalogMaxId: 8,
      upstream(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const route = url.searchParams.get('path');
        if (route === '/v3.0/tracks/') {
          if (initial) {
            initial = false;
            const ids = (url.searchParams.get('id') || '').split('+').filter(Boolean);
            return reply(res, ids.map(id => ({
              id, name: 'Existing ' + id, artist_name: 'Known ' + id, artist_id: 'artist-' + id,
              audio: 'https://api.jamendo.com/audio/' + id, license_ccurl: LICENSE,
            })));
          }
          opened++;
          res.on('close', () => { closed++; });
          res.writeHead(status, { 'Content-Type': 'text/plain' });
          return res.write('error body intentionally remains open');
        }
        if (route === '/v3.0/artists/locations/') return reply(res, []);
        if (route?.startsWith('/audio/')) return res.end('complete audio');
        res.writeHead(404);
        res.end();
      },
    });
    const first = await backend.request('/api/song');
    assert.equal(first.status, 200);
    const firstSong = await first.json();
    await backend.triggerRefresh();
    await backend.waitForOutput(/pool refresh failed/);
    await waitForClosed(() => opened, () => closed);

    const following = await backend.request('/api/song');
    assert.equal(following.status, 200);
    assert.notEqual((await following.json()).id, firstSong.id);
    assert.equal(await (await backend.request('/audio/' + firstSong.id)).text(), 'complete audio');
    assert.equal((await backend.request('/api/info')).status, 200);
  });
}

test('a failed individual Jamendo artist lookup releases its unfinished error body', async t => {
  let opened = 0;
  let closed = 0;
  const name = 'Network Cleanup Artist';
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    upstream(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const route = url.searchParams.get('path');
      if (route === '/v3.0/tracks/') return reply(res, [{
        id: '1', name: 'Track', artist_name: name,
        audio: 'https://api.jamendo.com/audio/1', license_ccurl: LICENSE,
      }]);
      if (route === '/v3.0/artists/') return reply(res, [{ id: '42', name }]);
      if (route === '/v3.0/artists/locations/') {
        opened++;
        res.on('close', () => { closed++; });
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.write('location unavailable');
      }
      if (route?.startsWith('/audio/')) return res.end('complete audio');
      res.writeHead(404);
      res.end();
    },
  });
  assert.equal((await backend.request('/api/song')).status, 200);
  assert.equal((await backend.request('/api/country?id=1')).status, 200);
  await waitForClosed(() => opened, () => closed);
  assert.equal((await backend.request('/api/info')).status, 200);
});

for (const status of [404, 503]) {
  test('MusicBrainz HTTP ' + status + ' releases error bodies before returning or retrying', async t => {
    let opened = 0;
    let closed = 0;
    const name = 'MusicBrainz Cleanup Artist';
    const backend = await startBackend(t, {
      catalogMaxId: 1,
      musicBrainzUpstream: true,
      upstream(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const route = url.searchParams.get('path');
        if (url.searchParams.get('source') === 'musicbrainz.org') {
          opened++;
          res.on('close', () => { closed++; });
          res.writeHead(status, { 'Content-Type': 'text/plain' });
          return res.write('musicbrainz unavailable');
        }
        if (route === '/v3.0/tracks/') return reply(res, [{
          id: '1', name: 'Track', artist_name: name, artist_id: '42',
          audio: 'https://api.jamendo.com/audio/1', license_ccurl: LICENSE,
        }]);
        if (route === '/v3.0/artists/locations/') return reply(res, []);
        if (route?.startsWith('/audio/')) return res.end('complete audio');
        res.writeHead(404);
        res.end();
      },
    });
    assert.equal((await backend.request('/api/song')).status, 200);
    const country = await fetch('http://127.0.0.1:' + backend.port + '/api/country?id=1', {
      signal: AbortSignal.timeout(6000),
    });
    assert.equal(country.status, 200);
    await waitForClosed(() => opened, () => closed);
    assert.equal(opened, status === 503 ? 3 : 1, 'retryable failures have a bounded retry count');
    assert.equal((await backend.request('/api/info')).status, 200);
  });
}
