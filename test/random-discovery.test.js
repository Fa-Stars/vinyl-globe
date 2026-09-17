'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDiscovery } = require('../web/random-discovery');
const { normalizeJamendoTrack } = require('../web/jamendo-metadata');
const { startBackend } = require('../test-support/backend.cjs');
const bounds = maxId => ({ maxId, checkedAt: Date.now() });

function randomSequence(values) { let i = 0; return () => values[i++ % values.length]; }

test('unlicensed results do not consume discovery slots before valid licensed tracks', async () => {
  const d = createDiscovery({ cachedBounds: bounds(4), random: randomSequence([0, 0.25, 0.5, 0.75]),
    acceptTrack: normalizeJamendoTrack,
    request: async p => ({ results: p.id.split('+').map(id => ({ id, audio: 'https://example.test/audio',
      license_ccurl: Number(id) % 2 === 0 ? 'https://creativecommons.org/licenses/by/4.0/' : '' })) }),
  });
  const tracks = await d.sample(2);
  assert.deepEqual(tracks.map(track => track.id), ['2', '4']);
  assert.ok(tracks.every(track => track.license.name === 'CC BY 4.0'));
});

test('random discovery samples distant exact IDs without deep pagination or API sort bias', async () => {
  const calls = [];
  const d = createDiscovery({ cachedBounds: bounds(1000), random: randomSequence([0.99, 0.01, 0.5]), request: async p => {
    calls.push(p);
    return { results: p.id.split('+').sort((a,b) => Number(a)-Number(b)).map(id => ({ id, audio: 'url' })) };
  }});
  assert.deepEqual((await d.sample(3)).map(t => t.id), ['991','11','501']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].offset, undefined);
  assert.equal(calls[0].fullcount, undefined);
});

test('ID holes, unrequested results, duplicates and played IDs never become nearby replacements', async () => {
  const d = createDiscovery({ cachedBounds: bounds(100), random: randomSequence([0,0.01,0.02,0.03,0.04]), request: async p => {
    assert.ok(!p.id.split('+').includes('1'));
    return { results: [{id:'2',audio:''},{id:'3',audio:'url'},{id:'3',audio:'url'}, {id:'99',audio:'unrequested'}, {id:'5',audio:'url'}] };
  }});
  assert.deepEqual((await d.sample(2,new Set(['1']))).map(t => t.id), ['3','5']);
});

test('a failed exact-ID batch is retryable without marking those IDs played', async () => {
  let calls = 0;
  const d = createDiscovery({ cachedBounds: bounds(1), random: () => 0, request: async p => {
    if (++calls === 1) throw new Error('temporary');
    return { results: [{ id:p.id, audio:'url' }] };
  }});
  assert.equal((await d.sample(1))[0].id,'1');
  assert.equal(calls,2);
});

test('missing catalog boundaries never silently become a fixed chart', async () => {
  const d = createDiscovery({ request: async () => ({ results: [] }) });
  await assert.rejects(d.sample(2), /Catalog ID range unavailable/);
});

test('cached boundaries serve songs while a single background refresh discovers a newer range', async () => {
  let release;
  let lookups = 0;
  let saved;
  let clock = 86400000;
  const d = createDiscovery({ now: () => clock, cachedBounds: {maxId:100,checkedAt:clock-7*3600000},
    random: () => 0.99, saveBounds: value => { saved=value; }, request: async p => {
      if (p.order) { lookups++; return new Promise(resolve => { release=resolve; }); }
      return { results: [{id:p.id, audio:'url'}] };
    },
  });
  assert.equal((await d.sample(1))[0].id,'100');
  assert.equal((await d.sample(1))[0].id,'100');
  assert.equal(lookups,1);
  release({results:[{id:'200'}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.maxId,200);
  assert.equal((await d.sample(1))[0].id,'199');
});

test('playback continuously replenishes remote candidates, never chooses based on known country', async t => {
  let calls=0;
  let batches=0;
  const tracks=new Set();
  const backend=await startBackend(t,{upstream(req,res){
    const u=new URL(req.url,'http://localhost');
    const route=u.searchParams.get('path');
    if(route==='/v3.0/artists/locations/'){
      batches++;
      const ids=(u.searchParams.get('id')||'').split(/[ +]/);
      res.end(JSON.stringify({headers:{status:'success'},results:ids.map(id=>({id,name:'Artist '+id,locations:[{country:'JPN'}]}))}));
      return;
    }
    assert.equal(u.searchParams.get('offset'),'0'); // Test proxy default; real request has no deep offset.
    assert.equal(u.searchParams.get('type'),'single+albumtrack');
    calls++;
    const ids=u.searchParams.get('id').split('+');
    res.end(JSON.stringify({headers:{status:'success'},results:ids.map(id=>({id,name:'Track '+id,artist_id:id,artist_name:'Artist '+id,audio:'http://127.0.0.1:1/audio',license_ccurl:'https://creativecommons.org/licenses/by-nc-sa/3.0/'}))}));
  }});
  await backend.waitForOutput(/new random tracks/);
  for(let i=0;i<15;i++){
    const response=await backend.request('/api/song');
    assert.equal(response.status,200);
    const song=await response.json();
    assert.ok(!tracks.has(song.id),'already delivered track repeated');
    tracks.add(song.id);
  }
  assert.equal(tracks.size,15);
  assert.ok(calls>=3,'remote discovery must continue beyond initial buffer');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.ok(batches>0,'locations should be fetched as a batch');
  const info=await (await backend.request('/api/info')).json();
  assert.ok(info.songs<=22,'at most 16 historical entries and 6 pending candidates');
  assert.equal(fs.existsSync(path.join(backend.root,'jamendo/pool.json')),false,'no persistent song pool');
  assert.equal(fs.existsSync(path.join(backend.root,'audio/_urls.json')),false,'no persistent audio URLs');
});
