'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startBackend(t, { mode = 'jamendo', pool = [], charts = {}, audio = {}, upstream, setup, catalogMaxId = 800000 } = {}) {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'vinyl-regression-'));
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  if (pool.length) write('jamendo/pool.json', pool);
  if (catalogMaxId) write('catalog-bounds.json', { maxId: catalogMaxId, checkedAt: Date.now() });
  for (const [code, songs] of Object.entries(charts)) write('songs/' + code + '.json', songs);
  for (const [id, bytes] of Object.entries(audio)) write('audio/' + id + '.mp3', bytes);
  if (setup) setup(root);

  const remote = http.createServer(upstream || ((_req, res) => {
    res.writeHead(404);
    res.end();
  }));
  await new Promise((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'backend-preload.cjs'), 'web/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      WORLD_VINYL_HOST: '127.0.0.1',
      JAMENDO_CLIENT_ID: mode === 'jamendo' ? 'test-only' : '',
      WORLD_VINYL_DATA_DIR: root,
      WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '0',
      WORLD_VINYL_BROWSER_LIFECYCLE: '0',
      WORLD_VINYL_TEST_UPSTREAM: 'http://127.0.0.1:' + remote.address().port,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let refreshDone;
  let finishRefresh;
  child.on('message', (message) => { if (message === 'refresh-finished' && finishRefresh) finishRefresh(); });
  const exit = once(child, 'exit');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
    const relative = path.relative(temp, fs.realpathSync(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Backend startup timed out\n' + output)), 5000);
    const onData = () => { if (output.includes('World Vinyl running at')) finish(); };
    const onExit = () => finish(new Error('Backend exited\n' + output));
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    }
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    onData();
  });
  return {
    root,
    port,
    child,
    get output() { return output; },
    waitForRefresh: () => refreshDone,
    request: (pathname, options = {}) => fetch('http://127.0.0.1:' + port + pathname, {
      ...options, signal: AbortSignal.timeout(3000),
    }),
    waitForOutput: (pattern) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Missing backend output: ' + pattern + '\n' + output)), 5000);
      const check = () => { if (pattern.test(output)) finish(); };
      const onExit = () => finish(new Error('Backend exited\n' + output));
      function finish(error) {
        clearTimeout(timer);
        child.stdout.off('data', check);
        child.stderr.off('data', check);
        child.off('exit', onExit);
        error ? reject(error) : resolve();
      }
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.once('exit', onExit);
      check();
    }),
    triggerRefresh: () => new Promise((resolve) => {
      refreshDone = new Promise((done) => { finishRefresh = done; });
      const onMessage = (message) => {
        if (message !== 'refresh-started') return;
        child.off('message', onMessage);
        resolve();
      };
      child.on('message', onMessage);
      child.send('refresh');
    }),
  };
}

module.exports = { startBackend };
