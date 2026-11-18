'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createDistributor } = require('../services/distributor');
const { createPreparer } = require('../services/preparer');
const { digest } = require('../services/protocol');
const { openLibrary } = require('../services/library');
const { writeCatalog, tone } = require('../test-support/split-fixture.cjs');

async function environment(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vinyl-v2-'));
  const directory = path.join(root, 'cloud'), token = randomUUID();
  const manifest = await writeCatalog(path.join(root, 'campus'));
  let server, origin;
  async function stop() {
    if (!server?.listening) return;
    const finished = once(server, 'close');
    server.close(); server.closeAllConnections(); await finished;
  }
  async function start() {
    server = createDistributor({ directory, token, target: 12 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  await start();
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { manifest, token, stop, start, get endpoint() { return origin; },
    request: (route, options) => fetch(origin + route, options) };
}

async function worker(env) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../services/preparer.js'), '--once'], {
    env: { ...process.env, VINYL_DISTRIBUTOR_URL: env.endpoint, VINYL_UPLOAD_TOKEN: env.token, VINYL_MANIFEST: env.manifest },
    stdio: ['ignore','pipe','pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  return output;
}

test('split services publish once, restore after restart and serve ten independent players through five skips', { timeout: 60000 }, async t => {
  const env = await environment(t);
  assert.match(await worker(env), /Published tracks: 6/);
  assert.match(await worker(env), /Published tracks: 6/);
  assert.match(await worker(env), /Published tracks: 0/);
  await env.stop(); await env.start();
  assert.equal((await (await env.request('/api/info')).json()).songs, 12);
  const players = await Promise.all(Array.from({ length: 10 }, async () => {
    const reply = await env.request('/api/listening-session', { method: 'POST' });
    return { token: (await reply.json()).token, ids: new Set() };
  }));
  for (let seq = 1; seq <= 6; seq++) {
    if (seq > 1 && process.env.VINYL_TEST_PACED === '1') await new Promise(r => setTimeout(r, 2000));
    await Promise.all(players.map(async player => {
      const headers = { 'X-Vinyl-Session': player.token, 'X-Vinyl-Sequence': String(seq) };
      const queue = (await (await env.request('/api/queue', { headers })).json()).tracks;
      assert.equal(queue.length, 5);
      const song = await (await env.request('/api/song', { headers })).json();
      assert.equal(song.id, queue[0].id);
      assert.equal((await (await env.request('/api/song', { headers })).json()).id, song.id);
      assert.ok(!player.ids.has(song.id)); player.ids.add(song.id);
      const audio = await env.request(song.streamUrl, { headers: { Range: 'bytes=0-4095' } });
      assert.equal(audio.status, 206);
      assert.deepEqual(Buffer.from(await audio.arrayBuffer()), tone(Number(song.id.slice(5))).subarray(0,4096));
    }));
  }
  assert.equal(new Set(players.map(p => p.token)).size, 10);
  assert.equal((await env.request('/audio/tone-0', { headers: { Range: 'bytes=999999-' } })).status, 416);
  const full = await env.request('/audio/tone-0');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), tone(0));
  await fs.writeFile(env.manifest, '[]');
  await worker(env);
  assert.equal((await env.request('/audio/tone-0')).status, 404);
});

test('upload authentication, checksum and media conflicts leave the original library intact', async t => {
  const env = await environment(t), audio = tone(0);
  const metadata = { id: 'one', artist: 'Test', title: 'One', grant: 'Original',
    validUntil: Date.now() + 60000, duration: 2, audioType: 'audio/wav', coverHash: digest(Buffer.alloc(0)) };
  async function put(audio, hash) {
    const form = new FormData();
    form.set('metadata', JSON.stringify({ ...metadata, audioHash: hash }));
    form.set('audio', new Blob([audio], { type: 'audio/wav' }), 'one.wav');
    return env.request('/internal/tracks/one', { method: 'PUT', headers: { Authorization: 'Bearer ' + env.token }, body: form });
  }
  assert.equal((await env.request('/internal/inventory')).status, 401);
  assert.equal((await put(audio, 'mismatch')).status, 422);
  assert.equal((await env.request('/audio/one')).status, 404);
  assert.equal((await put(audio, digest(audio))).status, 201);
  assert.equal((await put(audio, digest(audio))).status, 200);
  const other = tone(1);
  assert.equal((await put(other, digest(other))).status, 409);
  assert.deepEqual(Buffer.from(await (await env.request('/audio/one')).arrayBuffer()), audio);
});

test('approved Jamendo IDs are prepared only by the worker; cloud playback uses local media and attribution', async t => {
  const env = await environment(t);
  await fs.writeFile(env.manifest, JSON.stringify([{ provider: 'jamendo', id: '123', grant: 'Synthetic integration fixture',
    validUntil: new Date(Date.now() + 60000).toISOString() }]));
  const calls = [];
  const fetchMusic = async url => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === '/v3.0/tracks/') return Response.json({ results: [{ id: '123', name: 'Test', artist_id: '5',
      artist_name: 'Artist', audio: 'https://api.jamendo.com/stream/123', duration: 2,
      audiodownload_allowed: true, audiodownload: 'https://api.jamendo.com/audio/123',
      license_ccurl: 'https://creativecommons.org/licenses/by/4.0/' }] });
    if (u.pathname === '/v3.0/artists/locations/') return Response.json({ headers: { status: 'success' },
      results: [{ id: '5', name: 'Artist', locations: [{ country: 'GBR' }] }] });
    if (u.pathname === '/audio/123') return new Response('fixture audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    throw Error('Unexpected fixture request');
  };
  const run = createPreparer({ ...env, clientId: 'test-only', fetchMusic });
  assert.equal(await run(), 1);
  assert.equal(await run(), 0);
  const token = (await (await env.request('/api/listening-session', { method: 'POST' })).json()).token;
  const song = await (await env.request('/api/song', { headers: { 'X-Vinyl-Session': token, 'X-Vinyl-Sequence': '1' } })).json();
  assert.equal(song.countrycode, 'GB');
  assert.equal(song.license.name, 'CC BY 4.0');
  assert.equal(song.streamUrl, '/audio/123');
  assert.equal(await (await env.request(song.streamUrl)).text(), 'fixture audio');
  assert.equal(calls.length, 3);
});

test('Jamendo HTML content type requires two complete MP3 frames before upload', async t => {
  const env = await environment(t);
  await fs.writeFile(env.manifest, JSON.stringify([{ provider: 'jamendo', id: '987', grant: 'Test fixture',
    validUntil: new Date(Date.now() + 60000).toISOString() }]));
  const tag = Buffer.from([0x49,0x44,0x33,4,0,0,0,0,0,0]);
  const frame = Buffer.alloc(417); // MPEG-1 Layer III, 128 kb/s, 44.1 kHz.
  frame.set([0xff,0xfb,0x90,0x00]);
  let body;
  const run = createPreparer({ ...env, clientId: 'fixture', fetchMusic: async url => {
    if (new URL(url).pathname === '/download') return new Response(body, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    if (new URL(url).pathname === '/v3.0/tracks/') return Response.json({ results: [{
      id: '987', name: 'Sample', artist_id: '8', artist_name: 'Sample artist', audio: 'https://api.jamendo.com/stream',
      audiodownload_allowed: true, audiodownload: 'https://api.jamendo.com/download',
      license_ccurl: 'https://creativecommons.org/licenses/by/4.0/' }] });
    return Response.json({ headers: { status: 'success' }, results: [{ id: '8', locations: [{ country: 'GBR' }] }] });
  } });
  for (const invalid of [Buffer.from('<html>Unavailable</html>'), tag, Buffer.concat([tag, frame, frame.subarray(0, 4)])]) {
    body = invalid;
    await assert.rejects(run(), /Published 0 tracks, failed 1/);
    assert.equal((await env.request('/audio/987')).status, 404);
  }
  body = Buffer.concat([tag, frame, frame]);
  assert.equal(await run(), 1);
  const response = await env.request('/audio/987');
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test('a stream URL never substitutes for a disabled Jamendo download', async t => {
  const env = await environment(t);
  await fs.writeFile(env.manifest, JSON.stringify([{ provider: 'jamendo', id: '123', grant: 'Test fixture',
    validUntil: new Date(Date.now() + 60000).toISOString() }]));
  const requested = [];
  const run = createPreparer({ ...env, clientId: 'test-only', fetchMusic: async url => {
    const u = new URL(url);
    requested.push(u.pathname);
    assert.equal(u.searchParams.get('include'), 'licenses');
    return Response.json({ results: [{ id: '123', name: 'Test', artist_name: 'Artist',
      audio: 'https://api.jamendo.com/stream/123', audiodownload_allowed: false,
      audiodownload: '', license_ccurl: 'https://creativecommons.org/licenses/by/4.0/' }] });
  } });
  await assert.rejects(run(), /Published 0 tracks, failed 1/);
  assert.deepEqual(requested, ['/v3.0/tracks/']);
  assert.equal((await env.request('/audio/123')).status, 404);
});

test('rotation preserves pinned tracks and rolls back a replacement that exceeds capacity', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinyl-v2-quota-'));
  const library = openLibrary(dir, { maxBytes: 12, maxTracks: 2 });
  t.after(async () => { library.close(); await fs.rm(dir, { recursive: true, force: true }); });
  function put(id, size, replace, pinned = new Set()) {
    const track = { id, validUntil: Date.now() + 60000 };
    const audio = Buffer.alloc(size, 1);
    return library.put(track, audio, Buffer.alloc(0), digest(audio), pinned, replace);
  }
  put('a', 6); put('b', 6);
  assert.throws(() => put('c', 6, 'a', new Set(['a'])), { status: 409 });
  assert.throws(() => put('c', 7, 'a'), { status: 507 });
  assert.deepEqual(library.list().map(t => t.id).sort(), ['a', 'b']);
  put('c', 6, 'a');
  assert.deepEqual(library.list().map(t => t.id).sort(), ['b', 'c']);
});

test('country backfill updates metadata without republishing media and rejects stale revisions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinyl-v2-country-'));
  const library = openLibrary(dir, { maxBytes: 1000, maxTracks: 2 });
  t.after(async () => { library.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const track = { provider: 'jamendo', id: '42', artist: 'Artist', artistId: '2', countrycode: '',
    revision: 'r1', countryChecked: Date.now() - 700000, validUntil: Date.now() + 60000 };
  library.put(track, Buffer.from('audio'), Buffer.alloc(0), 'hash', new Set());
  assert.equal(library.pendingCountry().id, '42');
  assert.equal(library.updateCountry('42', 'old', 'CN', '中国').changes, 0);
  assert.equal(library.updateCountry('42', 'r1', 'CN', '中国').changes, 1);
  assert.equal(library.pendingCountry(), undefined);
  assert.equal(JSON.parse(library.find('42').meta).countrycode, 'CN');
  assert.equal(Buffer.from(library.read('audio', '42', 0, 5)).toString(), 'audio');
});
