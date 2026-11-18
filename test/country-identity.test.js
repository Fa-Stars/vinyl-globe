'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const names = ['constructor', '__proto__', 'toString'];
const license = 'https://creativecommons.org/licenses/by/4.0/';

function reply(res, results) {
  res.end(JSON.stringify({ headers: { status: 'success' }, results }));
}

async function artistBackend(t, name, options = {}) {
  let locationRequests = 0;
  const backend = await startBackend(t, {
    catalogMaxId: 1,
    ...options,
    upstream(req, res) {
      const route = new URL(req.url, 'http://localhost').searchParams.get('path');
      if (route === '/v3.0/tracks/') {
        reply(res, [{ id: '1', name: 'Dictionary Track', artist_id: '42', artist_name: name,
          audio: 'http://127.0.0.1:1/audio', license_ccurl: license }]);
      } else if (route === '/v3.0/artists/locations/') {
        locationRequests++;
        reply(res, [{ id: '42', name, locations: [{ country: 'FRA' }] }]);
      } else {
        reply(res, []);
      }
    },
  });
  return { backend, locationRequests: () => locationRequests };
}

for (const name of names) {
  test('resolves and caches artist named ' + name + ' without colliding with object properties', async t => {
    const { backend, locationRequests } = await artistBackend(t, name);
    const songResponse = await backend.request('/api/song');
    assert.equal(songResponse.status, 200);
    const song = await songResponse.json();
    assert.equal(song.artist, name);

    const requests = await Promise.all(Array.from({ length: 3 }, () => backend.request('/api/country?id=' + song.id)));
    for (const response of requests) {
      assert.equal(response.status, 200);
      const country = await response.json();
      assert.equal(country.countrycode, 'FR');
      assert.equal(country.status, 'resolved');
    }
    assert.equal(locationRequests(), 1, 'concurrent country requests should share the lookup');
    const saved = JSON.parse(backend.read('artist-countries.json'));
    assert.equal(Object.hasOwn(saved, name), true, 'special names must serialize as normal own keys');
    assert.equal(saved[name].code, 'FR');
    assert.equal((await backend.request('/api/info')).status, 200, 'backend remains alive');
  });

  test('loads cached country for artist named ' + name + ' as a normal record', async t => {
    const record = {
      code: 'JP', country: '日本', source: 'jamendo', artistId: '42',
      sourceUrl: 'https://www.jamendo.com/artist/42', resolverVersion: 9, ts: Date.now(),
    };
    const { backend, locationRequests } = await artistBackend(t, name, {
      setup(root) {
        const fs = require('node:fs');
        const path = require('node:path');
        fs.writeFileSync(path.join(root, 'artist-countries.json'), JSON.stringify({ [name]: record }));
      },
    });
    const songResponse = await backend.request('/api/song');
    assert.equal(songResponse.status, 200);
    const song = await songResponse.json();
    assert.equal(song.countrycode, 'JP');
    const response = await backend.request('/api/country?id=' + song.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).countrycode, 'JP');
    assert.equal(locationRequests(), 0, 'a valid saved record must not be fetched again');
    assert.equal(Object.hasOwn(JSON.parse(backend.read('artist-countries.json')), name), true);
    assert.equal((await backend.request('/api/info')).status, 200, 'backend remains alive');
  });
}
