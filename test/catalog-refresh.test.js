'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const oldTrack = { id: 'old', title: 'Old Track', artist: '', streamUrl: 'http://127.0.0.1:1/old.mp3', artwork: '', countrycode: 'US', country: '美国' };

test('Jamendo keeps serving the working catalog while a refresh is pending or fails', async (t) => {
  let failRefresh;
  let failed = false;
  let requested;
  const requestStarted = new Promise((resolve) => { requested = resolve; });
  const backend = await startBackend(t, {
    pool: [oldTrack, {...oldTrack,id:'old2',title:'Second Track'}], audio: { old:'cached-audio', old2:'cached-audio' },
    upstream(_req, res) {
      if (failed) { res.writeHead(404); res.end(); return; }
      failRefresh = () => { failed = true; res.writeHead(404); res.end(); };
      requested();
    },
  });
  await backend.triggerRefresh();
  await requestStarted;
  const during = await backend.request('/api/song');
  assert.equal(during.status, 200);
  const firstId = (await during.json()).id;
  failRefresh();
  await backend.waitForOutput(/pool refresh failed/);
  const after = await backend.request('/api/song');
  assert.equal(after.status, 200);
  assert.notEqual((await after.json()).id, firstId);
  assert.equal(await (await backend.request('/audio/old')).text(), 'cached-audio');
});

test('iTunes keeps a cached country available during a failed refresh', { timeout: 10000 }, async (t) => {
  let release;
  let requested;
  const requestStarted = new Promise((resolve) => { requested = resolve; });
  const backend = await startBackend(t, {
    mode: 'itunes', charts: { US: [oldTrack] },
    upstream(req, res) {
      const target = new URL(req.url, 'http://localhost').searchParams.get('path');
      if (target.startsWith('/us/')) {
        release = () => { res.writeHead(404); res.end(); };
        requested();
      } else { res.writeHead(404); res.end(); }
    },
  });
  await backend.waitForOutput(/priming done/);
  await backend.triggerRefresh();
  await requestStarted;
  const during = await backend.request('/api/song?country=US');
  assert.equal(during.status, 200);
  assert.equal((await during.json()).title, 'Old Track');
  release();
  await backend.waitForRefresh();
  const after = await backend.request('/api/song?country=US');
  assert.equal((await after.json()).title, 'Old Track');
  const countries = await (await backend.request('/api/countries')).json();
  assert.equal(countries.find((country) => country.code === 'US').count, 1);
});

test('a cold Jamendo startup can retry after the upstream recovers', async (t) => {
  let available = false;
  const backend = await startBackend(t, {
    upstream(_req, res) {
      if (!available) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ headers: { status: 'success', results_fullcount:100 }, results: [{ id: 'fresh', name: 'Fresh Track', audio: 'http://127.0.0.1:1/fresh.mp3' }] }));
    },
  });
  await backend.waitForOutput(/pool fetch failed/);
  available = true;
  const response = await backend.request('/api/song');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, 'fresh');
});

test('empty random batches preserve an already cached playable track', async t => {
  const backend = await startBackend(t, {
    pool:[oldTrack], audio:{old:'cached-audio'},
    upstream(_req,res){res.end(JSON.stringify({headers:{status:'success',results_fullcount:100},results:[]}));},
  });
  await backend.triggerRefresh();
  await backend.waitForRefresh();
  const response=await backend.request('/api/song');
  assert.equal(response.status,200);
  assert.equal((await response.json()).id,'old');
  assert.equal(await(await backend.request('/audio/old')).text(),'cached-audio');
});

test('a successful iTunes refresh replaces a cached chart', async (t) => {
  const backend = await startBackend(t, {
    mode: 'itunes', charts: { US: [oldTrack] },
    upstream(req, res) {
      const target = new URL(req.url, 'http://localhost').searchParams.get('path');
      if (!target.startsWith('/us/')) { res.writeHead(404); res.end(); return; }
      res.end(JSON.stringify({ feed: { entry: [{
        'im:name': { label: 'New Chart Track' },
        'im:artist': { label: 'Artist' },
        link: [{ attributes: { 'im:assetType': 'preview', href: 'https://example.test/preview.mp3' } }],
      }] } }));
    },
  });
  await backend.waitForOutput(/priming done/);
  await backend.triggerRefresh();
  await backend.waitForRefresh();
  assert.equal((await (await backend.request('/api/song?country=US')).json()).title, 'New Chart Track');
});
