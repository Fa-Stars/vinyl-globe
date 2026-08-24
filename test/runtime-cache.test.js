const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { clearRuntimeCache } = require('../runtime-cache');
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

test('clearRuntimeCache removes runtime data but preserves config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-cache-'));

  try {
    for (const dir of ['audio', 'jamendo', 'songs']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'marker.txt'), 'runtime');
    }
    fs.writeFileSync(path.join(root, 'artist-countries.json'), '{}');
    fs.writeFileSync(path.join(root, 'globe-CN.png'), 'runtime');
    fs.writeFileSync(path.join(root, 'config.json'), '{"jamendoClientId":"keep-me"}');

    const removed = clearRuntimeCache(root);

    assert.equal(removed, 5);
    for (const dir of ['audio', 'jamendo', 'songs']) {
      assert.equal(fs.existsSync(path.join(root, dir)), false);
    }
    assert.equal(fs.existsSync(path.join(root, 'artist-countries.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'globe-CN.png')), false);
    assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"jamendoClientId":"keep-me"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web page disconnect shuts down the direct server and clears its cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-web-'));
  for (const dir of ['audio', 'jamendo', 'songs']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'marker.txt'), 'runtime');
  }
  fs.writeFileSync(path.join(root, 'artist-countries.json'), '{}');
  fs.writeFileSync(path.join(root, 'config.json'), '{"jamendoClientId":"keep-me"}');

  const port = 38000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: '',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
      WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '1',
      WORLD_VINYL_BROWSER_LIFECYCLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  try {
    await waitForServer(child, port);
    const session = 'test-browser-session';
    const connected = await fetch('http://127.0.0.1:' + port + '/api/client-session?id=' + session + '&state=connect', { method: 'POST' });
    assert.equal(connected.status, 204);
    const disconnected = await fetch('http://127.0.0.1:' + port + '/api/client-session?id=' + session + '&state=disconnect', { method: 'POST' });
    assert.equal(disconnected.status, 204);

    const result = await exitPromise;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(fs.existsSync(path.join(root, 'config.json')), true);
    for (const dir of ['audio', 'jamendo', 'songs']) {
      assert.equal(fs.existsSync(path.join(root, dir)), false);
    }
    assert.equal(fs.existsSync(path.join(root, 'artist-countries.json')), false);
  } finally {
    if (!exited) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web server stays alive until a browser page has connected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-globe-web-start-'));
  fs.writeFileSync(path.join(root, 'config.json'), '{"jamendoClientId":"keep-me"}');
  const port = 37000 + (process.pid % 1000);
  const child = spawn(process.execPath, ['web/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      JAMENDO_CLIENT_ID: '',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_PORT: String(port),
      WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '1',
      WORLD_VINYL_BROWSER_LIFECYCLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  try {
    await waitForServer(child, port);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(exited, false);
  } finally {
    if (!exited) child.kill();
    await exitPromise;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
