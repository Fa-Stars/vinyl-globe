'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');
const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/';

const reply = (res, results, extra = {}) => res.end(JSON.stringify({ headers: { status: 'success', ...extra }, results }));

test('the first random song and country are available while the buffer is still being replenished', async t => {
  let searches = 0;
  const slow = [];
  let firstId;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      const route = u.searchParams.get('path');
      if (route === '/v3.0/artists/locations/') {
        reply(res, [{ id: 'artist-fast', name: 'Fast Artist', locations: [{ country: 'JPN' }] }]);
      } else if (route === '/audio-fast') {
        res.end('complete audio');
      } else if (u.searchParams.has('fullcount')) {
        reply(res, [], { results_fullcount: 800000 });
      } else if (++searches === 1) {
        firstId = u.searchParams.get('id').split('+')[0];
        reply(res, [{ id: firstId, name: 'Fast Track', artist_id: 'artist-fast', artist_name: 'Fast Artist',
          audio: 'https://api.jamendo.com/audio-fast', license_ccurl: LICENSE }]);
      } else {
        slow.push(res); // Leave the other catalog positions pending.
      }
    },
  });
  const before = performance.now();
  const response = await backend.request('/api/song');
  const song = await response.json();
  t.diagnostic('first song: ' + Math.round(performance.now() - before) + 'ms');
  assert.equal(response.status, 200);
  assert.equal(song.id, firstId);
  assert.equal((await (await backend.request('/api/country?id=' + song.id)).json()).countrycode, 'JP');
  assert.ok(slow.length > 0, 'the remaining searches are still pending');
  for (const res of slow) reply(res, []);
});

test('song metadata does not wait for a slow full audio download or country lookup', async t => {
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('path') === '/audio-slow') {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.write('first audio bytes'); // Entire track may take minutes to download.
      } else if (u.searchParams.get('path') === '/v3.0/artists/locations/') {
        // A slow independent metadata service must not prevent the song from starting.
      } else if (u.searchParams.get('path') === '/v3.0/tracks/') {
        reply(res, [{ id: '1', name: 'Slow', artist_name: 'Latency Artist', artist_id: '999999',
          audio: 'https://api.jamendo.com/audio-slow', license_ccurl: LICENSE }]);
      } else {
        reply(res, [], { results_fullcount: 100 });
      }
    },
  });
  const before = performance.now();
  const response = await backend.request('/api/song');
  const song = await response.json();
  const ms = Math.round(performance.now() - before);
  t.diagnostic('slow audio/country, song metadata: ' + ms + 'ms');
  assert.equal(response.status, 200);
  assert.equal(song.id, '1');
  assert.ok(ms < 600, 'metadata waited ' + ms + 'ms for unrelated work');
});

test('missing batch locations fall through to MusicBrainz without repeating the same Jamendo lookup', async t => {
  let locationRequests = 0;
  const backend = await startBackend(t, {
    upstream(req, res) {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('path') === '/v3.0/artists/locations/') {
        locationRequests++;
        reply(res, [{ id: '42', name: 'No Location', locations: [] }]);
      } else if (u.searchParams.has('fullcount')) {
        reply(res, [], { results_fullcount: 100 });
      } else {
        reply(res, [{ id: u.searchParams.get('id').split('+')[0], name: 'One', artist_id: '42', artist_name: 'No Location',
          audio: 'http://127.0.0.1:1/audio', license_ccurl: LICENSE }]);
      }
    },
  });
  await backend.waitForOutput(/new random tracks/);
  const song = await (await backend.request('/api/song')).json();
  for (let attempt = 0; attempt < 3; attempt++) {
    const country = await (await backend.request('/api/country?id=' + song.id)).json();
    if (country.status === 'none') break;
  }
  await backend.triggerRefresh();
  await backend.waitForRefresh();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(locationRequests, 1, 'an authoritative empty result should be reused for fallback');
});
