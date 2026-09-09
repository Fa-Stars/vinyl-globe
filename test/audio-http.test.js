'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const fixture = {
  id: 'fixture', title: 'Fixture', artist: '', duration: 10,
  streamUrl: 'http://127.0.0.1:1/audio', countrycode: '',
};

test('audio suffix Range returns the last bytes of the cached file', async (t) => {
  const backend = await startBackend(t, { pool: [fixture], audio: { fixture: '0123456789' } });
  const response = await backend.request('/audio/fixture', { headers: { Range: 'bytes=-4' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 6-9/10');
  assert.equal(await response.text(), '6789');
});

test('malformed audio paths are rejected without stopping the server', async (t) => {
  const backend = await startBackend(t, { pool: [fixture], audio: { fixture: '0123456789' } });
  for (const pathname of ['/audio/%', '/audio/%E0%A4', '/audio/%2e%2e%2fsecret', '/audio/toString']) {
    const response = await backend.request(pathname);
    assert.ok([400, 404].includes(response.status), pathname + ': ' + response.status);
    await response.text();
    assert.equal((await backend.request('/api/info')).status, 200);
  }
});

test('cached audio handles open, clamped and unsatisfiable ranges', async (t) => {
  const backend = await startBackend(t, { pool: [fixture], audio: { fixture: '0123456789' } });
  for (const [range, status, contentRange, body] of [
    ['bytes=3-', 206, 'bytes 3-9/10', '3456789'],
    ['bytes=7-999', 206, 'bytes 7-9/10', '789'],
    ['bytes=-99', 206, 'bytes 0-9/10', '0123456789'],
    ['bytes=10-', 416, 'bytes */10', ''],
    ['bytes=8-2', 416, 'bytes */10', ''],
    ['bytes=-0', 416, 'bytes */10', ''],
    ['bytes=-', 416, 'bytes */10', ''],
    ['bytes=9007199254740992-', 416, 'bytes */10', ''],
  ]) {
    const response = await backend.request('/audio/fixture', { headers: { Range: range } });
    assert.equal(response.status, status, range);
    assert.equal(response.headers.get('content-range'), contentRange, range);
    assert.equal(await response.text(), body, range);
  }
  const head = await backend.request('/audio/fixture', { method: 'HEAD', headers: { Range: 'bytes=3-' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
});

test('a cache write failure does not interrupt streaming or crash the backend', async (t) => {
  const backend = await startBackend(t, {
    pool: [{ ...fixture, streamUrl: 'https://api.jamendo.com/audio-fixture' }],
    setup(root) { fs.mkdirSync(path.join(root, 'audio', 'fixture.mp3.tmp'), { recursive: true }); },
    upstream(_req, res) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write('complete-');
      setTimeout(() => res.end('audio'), 50);
    },
  });
  const response = await backend.request('/audio/fixture');
  assert.equal(await response.text(), 'complete-audio');
  assert.equal((await backend.request('/api/info')).status, 200);
});

test('uncached audio forwards Range responses and survives an interrupted upstream', async (t) => {
  const backend = await startBackend(t, {
    pool: [{ ...fixture, streamUrl: 'https://api.jamendo.com/audio-fixture' }],
    upstream(req, res) {
      if (req.headers.range === 'bytes=3-5') {
        res.writeHead(206, { 'Content-Range': 'bytes 3-5/10', 'Content-Length': '3', 'Accept-Ranges': 'bytes' });
        res.end('345');
      } else {
        res.writeHead(200, { 'Content-Length': '10' });
        res.write('012');
        setTimeout(() => res.destroy(), 50);
      }
    },
  });
  const partial = await backend.request('/audio/fixture', { headers: { Range: 'bytes=3-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 3-5/10');
  assert.equal(await partial.text(), '345');
  await assert.rejects(async () => (await backend.request('/audio/fixture')).text());
  assert.equal((await backend.request('/api/info')).status, 200);
});

test('cancelling an audio response closes its upstream without stopping the server', { timeout: 5000 }, async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const backend = await startBackend(t, {
    pool: [{ ...fixture, streamUrl: 'https://api.jamendo.com/audio-fixture' }],
    upstream(req, res) {
      if (req.headers.range) {
        res.on('close', closed);
        res.writeHead(206, { 'Content-Range': 'bytes 0-999999/1000000' });
        res.write('begin');
      } else { res.writeHead(503); res.end(); }
    },
  });
  const response = await backend.request('/audio/fixture', { headers: { Range: 'bytes=0-' } });
  await response.body.cancel();
  await disconnected;
  assert.equal((await backend.request('/api/info')).status, 200);
});
