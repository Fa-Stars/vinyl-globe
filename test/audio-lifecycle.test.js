'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Expected lifecycle event did not occur');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const track = id => ({ id, title: id, artist: '', streamUrl: 'https://api.jamendo.com/audio-' + id });

test('releasing a warming track cancels its upstream and frees a download slot', async t => {
  const opened = new Set();
  const closed = new Set();
  const backend = await startBackend(t, {
    pool: ['a', 'b', 'c', 'd', 'e', 'f'].map(track),
    upstream(req, res) {
      const route = new URL(req.url, 'http://localhost').searchParams.get('path');
      if (!route.startsWith('/audio-')) { res.end('{}'); return; }
      const id = route.slice('/audio-'.length);
      opened.add(id);
      res.on('close', () => closed.add(id));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write('partial audio'); // Deliberately leave all download slots occupied.
    },
  });
  await waitUntil(() => opened.size === 3);
  const id = [...opened][0];
  const result = await backend.request('/api/audio/played?id=' + id, { method: 'POST' });
  assert.equal(result.status, 200);
  await waitUntil(() => closed.has(id) && opened.size >= 4);
  await waitUntil(() => !fs.existsSync(path.join(backend.root, 'audio', id + '.mp3.tmp')));
  assert.equal(fs.existsSync(path.join(backend.root, 'audio', id + '.mp3')), false);
});

test('a cancelled song request leaves every pending candidate available', { timeout: 6000 }, async t => {
  const pending = [];
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map(track);
  const backend = await startBackend(t, {
    upstream(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const route = url.searchParams.get('path');
      if (route.startsWith('/audio-')) { res.end('audio'); return; }
      if (route !== '/v3.0/tracks/') { res.end('{}'); return; }
      if (url.searchParams.has('fullcount')) {
        res.end(JSON.stringify({ headers: { status: 'success', results_fullcount: 800000 }, results: [] }));
      } else pending.push({res, ids: url.searchParams.get('id').split('+')});
    },
  });
  await waitUntil(() => pending.length === 1);
  const probe = http.get('http://127.0.0.1:' + backend.port + '/api/song');
  probe.on('error', () => {});
  await new Promise(resolve => probe.once('finish', resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  const closed = new Promise(resolve => probe.once('close', resolve));
  probe.destroy();
  await closed;
  // Finish discovery after the browser has left; no track should be consumed.
  for (const {res, ids} of pending) res.end(JSON.stringify({ headers: { status: 'success' },
    results: ids.slice(0,6).map(id => ({ id, name: id, audio: track(id).streamUrl })) }));
  await backend.waitForOutput(/\[audio\] cached/);
  await new Promise(resolve => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(backend.root, 'jamendo/pool.json')));
  assert.equal(saved.length, pool.length, 'an abandoned response must not consume a song');
});
