'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startBackend } = require('../test-support/backend.cjs');

async function waitBuffer(backend, predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const info = await (await backend.request('/api/info')).json();
    if (predicate(info.buffer)) return info.buffer;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('Standby did not converge\n' + backend.output);
}
function source({ downloads = [], fail = () => false, stalled = () => false } = {}) {
  return (req, res) => {
    const u = new URL(req.url, 'http://localhost'), route = u.searchParams.get('path');
    const reply = results => res.end(JSON.stringify({headers:{status:'success'},results}));
    if (route === '/v3.0/tracks/') {
      if (u.searchParams.get('order')) return reply([{id:'800000'}]);
      return reply((u.searchParams.get('id') || '').split('+').filter(Boolean).map(id => ({id,name:'Song '+id,artist_id:id,artist_name:'Artist '+id,
        audio:'https://api.jamendo.com/audio/'+id,image:'https://api.jamendo.com/image/'+id,duration:180,
        license_ccurl:'https://creativecommons.org/licenses/by/4.0/'})));
    }
    if (route === '/v3.0/artists/locations/') return reply((u.searchParams.get('id')||'').split('+').map(id=>({id,name:'Artist '+id,locations:[{country:'USA'}]})));
    if (route?.startsWith('/image/')) { res.setHeader('Content-Type','image/jpeg'); return res.end('fixture-image'); }
    if (route?.startsWith('/audio/')) {
      downloads.push(route.slice(7));
      if (fail()) {res.writeHead(503);return res.end();}
      res.setHeader('Content-Type','audio/mpeg');
      if (stalled()) return res.write('pending');
      return res.end('whole-cached-song');
    }
    res.writeHead(404);res.end();
  };
}

test('server mode prepares four complete songs without visitors, and a visit uses cached audio and artwork', async t => {
  const downloads = [];
  const backend = await startBackend(t,{serverMode:true,upstream:source({downloads})});
  const buffer = await waitBuffer(backend,b=>b?.ready===4 && b.downloading===0);
  assert.equal(downloads.length,4);
  assert.equal(buffer.audioMaxBytes,1024*1024*1024);
  for(let i=0;i<3;i++)await backend.maintain();
  assert.equal(downloads.length,4,'healthy idle buffer must not trigger new downloads');
  const song=await(await backend.request('/api/song')).json();
  assert.match(song.artwork,/^\/artwork\/\d+$/);
  const audio=await backend.request(song.streamUrl,{headers:{Range:'bytes=0-4'}});
  assert.equal(audio.status,206);assert.equal(await audio.text(),'whole');
  const location = await (await backend.request('/api/country?id=' + song.id)).json();
  assert.equal(location.countrycode, 'US');
  const image=await backend.request(song.artwork);assert.equal(image.headers.get('content-type'),'image/jpeg');assert.equal(await image.text(),'fixture-image');
  await waitBuffer(backend,b=>b.ready===4 && b.downloading===0);
  assert.equal(downloads.length,4,'legacy clients reuse the reserve without draining it');
  const files=fs.readdirSync(path.join(backend.root,'audio')).filter(f=>f.endsWith('.mp3'));
  assert.ok(files.length<=48);
});

test('server mode rolls an idle buffer one song at a time before expiry', async t=>{
  const now=Date.now(),downloads=[];let stalled=false;
  const backend=await startBackend(t,{serverMode:true,now,upstream:source({downloads,stalled:()=>stalled})});
  await waitBuffer(backend,b=>b?.ready===4 && !b.downloading);
  const before=fs.readdirSync(path.join(backend.root,'audio')).filter(f=>f.endsWith('.mp3'));
  stalled=true;
  await backend.setClock(now+10*60000+1);await backend.maintain();
  await waitBuffer(backend,b=>b.ready===3 && b.downloading===1);
  for(const f of before)assert.ok(backend.exists('audio/'+f),'old complete files survive while the replacement is pending');
  const song=await(await backend.request('/api/song')).json();
  assert.equal(await(await backend.request(song.streamUrl)).text(),'whole-cached-song');
});

test('failed idle refresh restores a usable buffer and backs off instead of looping', async t=>{
  const now=Date.now(),downloads=[];let fail=false;
  const backend=await startBackend(t,{serverMode:true,now,upstream:source({downloads,fail:()=>fail})});
  await waitBuffer(backend,b=>b?.ready===4 && !b.downloading);
  fail=true;await backend.setClock(now+10*60000+1);await backend.maintain();
  await waitBuffer(backend,b=>b.ready===4 && !b.downloading);
  const hits=downloads.length;
  for(let i=0;i<5;i++)await backend.maintain();
  await new Promise(r=>setTimeout(r,150));assert.equal(downloads.length,hits);
});

test('server mode prunes expired artist records and caps the persistent dictionary', async t=>{
  const now=Date.now();
  const backend=await startBackend(t,{serverMode:true,credentials:false,now,setup(root){
    const records=Object.fromEntries(Array.from({length:2100},(_,i)=>['Artist '+i,{ts:now-1000,resolverVersion:9,source:'jamendo',code:'US'}]));
    records.expired={ts:now-31*86400000,resolverVersion:9,source:'jamendo',code:'US'};
    fs.writeFileSync(path.join(root,'artist-countries.json'),JSON.stringify(records));
  }});
  await backend.maintain();const saved=JSON.parse(backend.read('artist-countries.json'));
  assert.ok(Object.keys(saved).length<=2000);assert.equal(saved.expired,undefined);
});

test('an unattended server keeps its four-song reserve across multiple original expiry windows',async t=>{
 const now=Date.now(),downloads=[];
 const backend=await startBackend(t,{serverMode:true,now,upstream:source({downloads})});
 await waitBuffer(backend,b=>b?.ready===4&&!b.downloading);
 for(let minute=10;minute<=32;minute++){
  await backend.setClock(now+minute*60000+1);await backend.maintain();
  const during=await(await backend.request('/api/info')).json();
  assert.ok(during.buffer.ready>=3,'standby was cleared at minute '+minute);
  await waitBuffer(backend,b=>b.ready===4&&!b.downloading&&!b.queued);
  const files=fs.readdirSync(path.join(backend.root,'audio')).filter(f=>f.endsWith('.mp3'));
  assert.ok(files.length<=48);
 }
 assert.ok(downloads.length>8,'actual replacements occurred, rather than retaining expired metadata');
});

test('empty files and HTML error pages are not counted as fully prepared audio',async t=>{
 for(const html of [false,true]){
  let hits=0;const normal=source();
  const backend=await startBackend(t,{serverMode:true,upstream(req,res){
   const u=new URL(req.url,'http://localhost');
   if(u.searchParams.get('path')?.startsWith('/audio/')){
    hits++;res.setHeader('content-type',html?'text/html':'audio/mpeg');return res.end(html?'<html>error</html>':'');
   }
   normal(req,res);
  }});
  const end=Date.now()+5000;while(hits<2&&Date.now()<end)await new Promise(r=>setTimeout(r,25));
  assert.equal(hits,2);
  const info=await(await backend.request('/api/info')).json();assert.equal(info.buffer.ready,0);
  for(let i=0;i<3;i++)await backend.maintain();
  await new Promise(r=>setTimeout(r,150));assert.equal(hits,2);
 }
});
