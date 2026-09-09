'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createDiscovery} = require('../web/random-discovery');
const {startBackend} = require('../test-support/backend.cjs');

test('random discovery samples distant catalog positions and includes singles', async () => {
  const calls=[];
  const values=[0.01,0.5,0.99];
  const discovery=createDiscovery({random:()=>values.shift() || 0,request:async params=>{
    calls.push(params);
    return {headers:{results_fullcount:800000},results:[{id:params.offset,audio:'audio'}]};
  }});
  const result=await discovery.sample(3);
  assert.deepEqual(result.map(t=>t.id),['8000','400000','792000']);
  assert.equal(calls.filter(p=>p.fullcount).length,1);
});

test('random discovery rejects played IDs and tolerates an individual failed request', async () => {
  let n=0;
  const d=createDiscovery({random:()=> (++n)/100,request:async p=>{
    if(p.fullcount)return {headers:{results_fullcount:100}};
    if(p.offset==='2')throw new Error('temporary failure');
    return {results:[{id:p.offset,audio:'url'}]};
  }});
  const result=await d.sample(2,new Set(['1']));
  assert.equal(result.length,2);
  assert.ok(result.every(t=>!['1','2'].includes(t.id)));
});

test('missing catalog totals do not silently turn into a small fixed chart', async () => {
  const d=createDiscovery({request:async()=>({results:[{id:'1',audio:'url'}]})});
  await assert.rejects(d.sample(2),/Catalog size unavailable/);
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
      const ids=(u.searchParams.get('id')||'').split(' ');
      res.end(JSON.stringify({headers:{status:'success'},results:ids.map(id=>({id,name:'Artist '+id,locations:[{country:'JPN'}]}))}));
      return;
    }
    assert.equal(u.searchParams.get('order'),'id');
    assert.equal(u.searchParams.get('type'),'single albumtrack');
    if(u.searchParams.get('fullcount')){res.end(JSON.stringify({headers:{status:'success',results_fullcount:800000},results:[]}));return;}
    calls++;
    const id=String(calls);
    res.end(JSON.stringify({headers:{status:'success'},results:[{id,name:'Track '+id,artist_id:id,artist_name:'Artist '+id,audio:'http://127.0.0.1:1/audio'}]}));
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
  assert.ok(calls>6,'remote discovery must continue beyond initial buffer');
  assert.ok(batches>0,'locations should be fetched as a batch');
});
