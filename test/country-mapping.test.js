'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  extractMusicBrainzCountryCode,
  selectMusicBrainzCountryCode,
} = require('../web/country-resolver');

const projectRoot = path.resolve(__dirname, '..');

test('reads MusicBrainz hyphenated ISO country codes', () => {
  const artist = {
    name: 'pornophonique',
    area: {
      name: 'Germany',
      'iso-3166-1-codes': ['DE'],
    },
  };
  assert.equal(extractMusicBrainzCountryCode(artist, { DE: '德国' }), 'DE');
});

test('reads a country from the MusicBrainz begin-area fallback', () => {
  const artist = {
    name: 'Borrtex',
    area: { name: 'Los Angeles' },
    'begin-area': {
      name: 'Praha',
      'iso-3166-1-codes': ['CZ'],
    },
  };
  assert.equal(extractMusicBrainzCountryCode(artist, { CZ: '捷克' }), 'CZ');
});

test('maps a MusicBrainz country area name when an ISO code is absent', () => {
  const artist = {
    name: 'Example Artist',
    area: { name: 'Germany' },
  };
  assert.equal(extractMusicBrainzCountryCode(artist, { DE: '德国' }), 'DE');
});

test('keeps the only trustworthy country among duplicate exact artist matches', () => {
  const artists = [
    { name: 'Example Artist', area: { name: '[Worldwide]' } },
    { name: 'Example Artist', area: { 'iso-3166-1-codes': ['JP'] } },
  ];
  assert.equal(selectMusicBrainzCountryCode(artists, 'Example Artist', { JP: '日本' }), 'JP');
});

test('rejects duplicate exact artist matches that disagree on country', () => {
  const artists = [
    { name: 'Example Artist', area: { 'iso-3166-1-codes': ['JP'] } },
    { name: 'Example Artist', area: { 'iso-3166-1-codes': ['US'] } },
  ];
  assert.equal(
    selectMusicBrainzCountryCode(artists, 'Example Artist', { JP: '日本', US: '美国' }),
    null,
  );
});

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('World Vinyl running at http://127.0.0.1:' + port)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error('server exited before startup (' + code + ')\n' + output));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

test('ignores legacy pools and untrusted country records when discovering live Jamendo songs', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'world-vinyl-country-'));
  const jamendoRoot = path.join(dataRoot, 'jamendo');
  fs.mkdirSync(jamendoRoot, { recursive: true });
  fs.writeFileSync(path.join(jamendoRoot, 'pool.json'), JSON.stringify([
    {
      id: '1307225',
      title: "This Ain't Love",
      artist: 'Unverified Fixture Artist',
      album: '',
      streamUrl: 'https://example.test/jyant.mp3',
      artwork: '',
      duration: 180,
      countrycode: 'CN',
      country: '中国',
    },
    {
      id: '1305161',
      title: 'Give U My Name',
      artist: 'Unverified Fixture Artist',
      album: '',
      streamUrl: 'https://example.test/jyant-2.mp3',
      artwork: '',
      duration: 180,
      countrycode: 'CN',
      country: '中国',
    },
    {
      id: '9999999',
      title: 'Another Track',
      artist: 'Another Artist',
      album: '',
      streamUrl: 'https://example.test/another.mp3',
      artwork: '',
      duration: 180,
      countrycode: 'CN',
      country: '中国',
    },
  ]));
  fs.writeFileSync(path.join(dataRoot, 'artist-countries.json'), JSON.stringify({
    'Unverified Fixture Artist': {
      code: 'CN',
      country: '中国',
      source: 'none',
      resolverVersion: 2,
      ts: Date.now(),
    },
    'Another Artist': {
      code: 'CN',
      country: '中国',
      source: 'none',
      resolverVersion: 2,
      ts: Date.now(),
    },
  }));

  fs.writeFileSync(path.join(dataRoot, 'catalog-bounds.json'), JSON.stringify({ maxId: 3, checkedAt: Date.now() }));
  const port = 32000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['--require', path.join(projectRoot, 'test-support/country-empty-preload.cjs'), 'web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WORLD_VINYL_DATA_DIR: dataRoot,
      JAMENDO_CLIENT_ID: 'test-only',
      PORT: String(port),
      WORLD_VINYL_HOST: '127.0.0.1',
      WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '0',
      WORLD_VINYL_BROWSER_LIFECYCLE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  try {
    await waitForServer(child, port);
    const first = await fetch('http://127.0.0.1:' + port + '/api/song', { signal: AbortSignal.timeout(5000) });
    assert.equal(first.status, 200);
    assert.ok(['1', '2', '3'].includes((await first.json()).id));
    assert.equal(fs.existsSync(path.join(jamendoRoot, 'pool.json')), false);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/api/country?id=1307225')).status, 404);
    for (const id of ['1', '2', '3']) {
      const response = await fetch('http://127.0.0.1:' + port + '/api/country?id=' + id);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.countrycode, '', JSON.stringify(result));
      assert.equal(result.status, 'none', JSON.stringify(result));
    }
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(dataRoot));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
