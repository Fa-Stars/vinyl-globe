'use strict';

// Cold-start probe: use an isolated cache and report timings, never credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

(async () => {
  const project = path.resolve(__dirname, '../..');
  let clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) {
    try { clientId = JSON.parse(fs.readFileSync(path.join(project, 'data/config.json'), 'utf8')).jamendoClientId; } catch {}
  }
  if (!clientId) throw new Error('Configure JAMENDO_CLIENT_ID or data/config.json first');
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'vinyl-timing-'));
  const boundsFile = path.join(project, 'data/catalog-bounds.json');
  if (process.argv.includes('--reuse-bounds') && fs.existsSync(boundsFile)) {
    fs.copyFileSync(boundsFile, path.join(root, 'catalog-bounds.json'));
    console.log(JSON.stringify({ event: 'using-cached-catalog-boundary' }));
  }
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const started = performance.now();
  const trace = process.argv.includes('--trace');
  const child = spawn(process.execPath, [...(trace ? ['--require', './test-support/timing-preload.cjs'] : []), 'web/server.js'], {
    cwd: project,
    env: { ...process.env, PORT: String(port), JAMENDO_CLIENT_ID: clientId,
      WORLD_VINYL_DATA_DIR: root, WORLD_VINYL_HOST: '127.0.0.1',
      WORLD_VINYL_CLEAR_CACHE_ON_EXIT: '0', WORLD_VINYL_BROWSER_LIFECYCLE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  child.stderr.resume();
  let ready = false;
  let lines = '';
  child.stdout.on('data', chunk => {
    lines += chunk;
    const parts = lines.split('\n');
    lines = parts.pop();
    for (const line of parts) {
      if (line.includes('World Vinyl running at')) ready = true;
      if (trace && line.startsWith('[timing]')) console.log(line);
    }
  });
  const elapsed = () => Math.round(performance.now() - started);
  const request = route => fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(60000) });
  try {
    while (!ready) {
      if (elapsed() > 5000 || child.exitCode !== null) throw new Error('Backend startup failed');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    console.log(JSON.stringify({ event: 'server-ready', ms: elapsed() }));
    const response = await request('/api/song');
    if (!response.ok) throw new Error('Song request HTTP ' + response.status);
    const song = await response.json();
    console.log(JSON.stringify({ event: 'first-song', ms: elapsed(), countryReady: !!song.countrycode }));
    await Promise.all([
      (async () => {
        const audio = await request(song.streamUrl);
        if (!audio.ok || !audio.body) throw new Error('Audio request HTTP ' + audio.status);
        const reader = audio.body.getReader();
        let bytes = 0;
        while (bytes < 64 * 1024) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
        }
        await reader.cancel();
        console.log(JSON.stringify({ event: 'audio-first-64KiB', ms: elapsed(), bytes }));
      })(),
      (async () => {
        const result = await (await request('/api/country?id=' + encodeURIComponent(song.id))).json();
        console.log(JSON.stringify({ event: 'country-result', ms: elapsed(), status: result.status, code: result.countrycode }));
      })(),
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    if (process.argv.includes('--prime-bounds') && fs.existsSync(path.join(root, 'catalog-bounds.json'))) {
      fs.mkdirSync(path.dirname(boundsFile), { recursive: true });
      fs.copyFileSync(path.join(root, 'catalog-bounds.json'), boundsFile);
    }
    const relative = path.relative(temp, fs.realpathSync(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe timing cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
