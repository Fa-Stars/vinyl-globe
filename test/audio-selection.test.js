const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function waitForServer(child, port) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('World Vinyl running at http://127.0.0.1:' + port)) finish(resolve);
    };
    const onExit = (code) => finish(() => reject(new Error('server exited before startup (' + code + ')\n' + output)));
    const finish = (callback) => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      callback();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

test('selects a cached audio track before an uncached track with known country', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-audio-'));
  const jamendoRoot = path.join(root, 'jamendo');
  const audioRoot = path.join(root, 'audio');
  fs.mkdirSync(jamendoRoot, { recursive: true });
  fs.mkdirSync(audioRoot, { recursive: true });

  const pool = [
    {
      id: 'ready-track',
      title: 'Ready Track',
      artist: 'Unknown Artist',
      album: '',
      streamUrl: 'http://127.0.0.1:1/ready.mp3',
      artwork: '',
      duration: 180,
      countrycode: '',
      country: '未知地区',
    },
    {
      id: 'cold-track',
      title: 'Cold Track',
      artist: 'Known Artist',
      album: '',
      streamUrl: 'http://127.0.0.1:1/cold.mp3',
      artwork: '',
      duration: 180,
      countrycode: '',
      country: '未知地区',
    },
  ];
  fs.writeFileSync(path.join(jamendoRoot, 'pool.json'), JSON.stringify(pool));
  fs.writeFileSync(path.join(audioRoot, '_urls.json'), JSON.stringify({
    'ready-track': { url: pool[0].streamUrl, type: 'audio/mpeg' },
    'cold-track': { url: pool[1].streamUrl, type: 'audio/mpeg' },
  }));
  fs.writeFileSync(path.join(audioRoot, 'ready-track.mp3'), 'cached-audio');
  fs.writeFileSync(path.join(root, 'artist-countries.json'), JSON.stringify({
    'Known Artist': {
      code: 'US',
      country: '美国',
      source: 'mb',
      resolverVersion: 2,
      ts: Date.now(),
    },
  }));

  const port = 36000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: 'test-only',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
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
    const response = await fetch('http://127.0.0.1:' + port + '/api/song');
    assert.equal(response.status, 200);
    const song = await response.json();
    assert.equal(song.id, 'ready-track', JSON.stringify(song));
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not queue a second warm download for an audio request already warming', async () => {
  const upstreamHits = new Map();
  const upstream = http.createServer((req, res) => {
    upstreamHits.set(req.url, (upstreamHits.get(req.url) || 0) + 1);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.write('audio-start');
    setTimeout(() => res.end('-audio-end'), 250);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-warm-'));
  const jamendoRoot = path.join(root, 'jamendo');
  const audioRoot = path.join(root, 'audio');
  fs.mkdirSync(jamendoRoot, { recursive: true });
  fs.mkdirSync(audioRoot, { recursive: true });
  const pool = [
    { id: 'warm-a', title: 'Warm A', artist: 'Artist A', streamUrl: 'http://127.0.0.1:' + upstreamPort + '/a.mp3', artwork: '', duration: 180 },
    { id: 'warm-b', title: 'Warm B', artist: 'Artist B', streamUrl: 'http://127.0.0.1:' + upstreamPort + '/b.mp3', artwork: '', duration: 180 },
  ];
  fs.writeFileSync(path.join(jamendoRoot, 'pool.json'), JSON.stringify(pool));
  fs.writeFileSync(path.join(root, 'artist-countries.json'), '{}');

  const port = 35000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: 'test-only',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
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
    const response = await fetch('http://127.0.0.1:' + port + '/audio/warm-a');
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(upstreamHits.get('/a.mp3'), 2);
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns a cold Jamendo track before the full warm download finishes', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.write('audio-start');
    setTimeout(() => res.end('-audio-end'), 900);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-warm-first-'));
  const jamendoRoot = path.join(root, 'jamendo');
  fs.mkdirSync(jamendoRoot, { recursive: true });
  fs.writeFileSync(path.join(jamendoRoot, 'pool.json'), JSON.stringify([{
    id: 'first-track',
    title: 'First Track',
    artist: 'Artist',
    streamUrl: 'http://127.0.0.1:' + upstreamPort + '/first.mp3',
    artwork: '',
    duration: 180,
  }]));
  fs.writeFileSync(path.join(root, 'artist-countries.json'), '{}');

  const port = 34000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: 'test-only',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
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
    const startedAt = Date.now();
    const response = await fetch('http://127.0.0.1:' + port + '/api/song');
    const elapsed = Date.now() - startedAt;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 700, 'metadata waited for the full download: ' + elapsed + 'ms');
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('played audio cleanup removes the file but keeps remote metadata usable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-played-'));
  const jamendoRoot = path.join(root, 'jamendo');
  const audioRoot = path.join(root, 'audio');
  fs.mkdirSync(jamendoRoot, { recursive: true });
  fs.mkdirSync(audioRoot, { recursive: true });
  const song = {
    id: 'played-track',
    title: 'Played Track',
    artist: 'Artist',
    streamUrl: 'http://127.0.0.1:1/played.mp3',
    artwork: '',
    duration: 180,
  };
  fs.writeFileSync(path.join(jamendoRoot, 'pool.json'), JSON.stringify([song]));
  fs.writeFileSync(path.join(audioRoot, '_urls.json'), JSON.stringify({
    'played-track': { url: song.streamUrl, type: 'audio/mpeg' },
  }));
  fs.writeFileSync(path.join(audioRoot, 'played-track.mp3'), 'cached-audio');

  const port = 33000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: 'test-only',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
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
    const response = await fetch('http://127.0.0.1:' + port + '/api/audio/played?id=played-track', { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(audioRoot, 'played-track.mp3')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(audioRoot, '_urls.json'), 'utf8'))['played-track'].url, song.streamUrl);
    assert.equal(JSON.parse(fs.readFileSync(path.join(jamendoRoot, 'pool.json'), 'utf8'))[0].id, song.id);
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
