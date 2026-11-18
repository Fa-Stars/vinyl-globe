'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {startBackend}=require('../test-support/backend.cjs');

function source(downloads) {
  return (req,res)=>{
    const u=new URL(req.url,'http://localhost'), route=u.searchParams.get('path');
    const reply=results=>res.end(JSON.stringify({headers:{status:'success'},results}));
    if (route==='/v3.0/tracks/') {
      if(u.searchParams.get('order')) return reply([{id:'800000'}]);
      return reply((u.searchParams.get('id')||'').split('+').filter(Boolean).map(id=>({id,name:'Track '+id,
        artist_id:id,artist_name:'Artist '+id,audio:'https://api.jamendo.com/audio/'+id,
        image:'https://api.jamendo.com/image/'+id,duration:180,license_ccurl:'https://creativecommons.org/licenses/by/4.0/'})));
    }
    if(route==='/v3.0/artists/locations/') return reply((u.searchParams.get('id')||'').split('+').map(id=>({id,name:'Artist '+id,locations:[{country:'USA'}]})));
    if(route?.startsWith('/image/')) {res.setHeader('Content-Type','image/jpeg');return res.end('cover');}
    if(route?.startsWith('/audio/')) {
      downloads.push(route.slice(7)); res.setHeader('Content-Type','audio/mpeg');
      return setTimeout(()=>res.end('cached-complete-audio'),20);
    }
    res.writeHead(404);res.end();
  };
}
async function wait(backend,predicate) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) { const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,20)); }
  assert.fail('Buffer did not converge\n'+backend.output);
}
async function connect(b) {
  const r=await b.request('/api/listening-session',{method:'POST'});assert.equal(r.status,200);return (await r.json()).token;
}
const headers=token=>token ? {'X-Vinyl-Session':token} : {};
async function info(b,token) {const r=await b.request('/api/info',{headers:headers(token)});assert.equal(r.status,200);return r.json();}
async function take(b,token,sequence) {
  const r=await b.request('/api/song',{headers:{...headers(token),'X-Vinyl-Sequence':String(sequence)}});
  assert.equal(r.status,200,await (r.status===200?Promise.resolve(''):r.text()));return r.json();
}

test('ten listeners own two ready songs and simultaneous switching cannot drain another queue',async t=>{
  const downloads=[],b=await startBackend(t,{serverMode:true,upstream:source(downloads)});
  await wait(b,async()=>((await info(b)).buffer.ready===4));
  const tokens=await Promise.all(Array.from({length:10},()=>connect(b)));
  assert.equal(new Set(tokens).size,10);
  const first=await Promise.all(tokens.map(token=>take(b,token,1)));
  await wait(b,async()=>{
    const states=await Promise.all(tokens.map(token=>info(b,token)));
    return states.every(s=>s.buffer.personal.ready===2 && s.buffer.downloading===0);
  });
  const before=await info(b,tokens[1]);
  const expected=before.buffer.personal.ids;
  const a=await take(b,tokens[0],2);
  assert.deepEqual((await info(b,tokens[1])).buffer.personal.ids,expected);
  // Releasing A's previous track is harmless even when B was assigned that file.
  await b.request('/api/audio/played?id='+first[0].id,{method:'POST',headers:headers(tokens[0])});
  const old=await b.request(first[0].streamUrl,{headers:{Range:'bytes=0-5'}});
  assert.equal(old.status,206);assert.equal(await old.text(),'cached');
  const switched=await Promise.all(tokens.map((token,i)=>take(b,token,i===0?3:2)));
  for(let i=0;i<10;i++) {
    assert.notEqual(switched[i].id,first[i].id);
    const audio=await b.request(switched[i].streamUrl,{headers:{Range:'bytes=0-5'}});
    assert.equal(audio.status,206);assert.equal(await audio.text(),'cached');
  }
  assert.notEqual(a.id,first[0].id);
  const peak=await info(b);
  assert.equal(peak.personalQueues,true);assert.equal(peak.buffer.sessions,10);
  assert.equal(peak.buffer.audioMaxBytes,1024**3);
  assert.ok(peak.buffer.downloading<=2);assert.ok(peak.buffer.audioFiles<=48);
  assert.ok(peak.buffer.audioBytes<=peak.buffer.audioMaxBytes);
  assert.equal(new Set(downloads).size,downloads.length,'shared tracks download once');
});

test('sequence retries are idempotent; capacity, expiry and per-session release are bounded',async t=>{
  const now=Date.now(),b=await startBackend(t,{serverMode:true,now,upstream:source([])});
  await wait(b,async()=>((await info(b)).buffer.ready===4));
  const token=await connect(b),s=await take(b,token,1);
  const retry=await take(b,token,1);assert.equal(retry.id,s.id);
  const second=await take(b,token,2);assert.notEqual(second.id,s.id);
  const stale=await b.request('/api/song',{headers:{...headers(token),'X-Vinyl-Sequence':'1'}});
  assert.equal(stale.status,409);
  for(let i=0;i<9;i++)await connect(b);
  const full=await b.request('/api/listening-session',{method:'POST'});assert.equal(full.status,503);
  const close=await b.request('/api/listening-session',{method:'POST',body:JSON.stringify({token,state:'disconnect'})});
  assert.equal(close.status,204);assert.equal((await info(b)).buffer.sessions,9);
  await connect(b);
  await b.setClock(now+120001);await b.maintain();
  assert.equal((await info(b)).buffer.sessions,0);
  const expired=await b.request('/api/song',{headers:{...headers(token),'X-Vinyl-Sequence':'3'}});assert.equal(expired.status,401);
});

test('paused pages stop replenishing while hidden playing pages keep independent queues',async t=>{
  const now=Date.now(),b=await startBackend(t,{serverMode:true,now,upstream:source([])});
  await wait(b,async()=>((await info(b)).buffer.ready===4));
  const paused=await connect(b),playing=await connect(b);
  await take(b,paused,1);await take(b,playing,1);
  for(let minute=1;minute<=6;minute++) {
    await b.setClock(now+minute*60000);
    for(const [token,isPlaying] of [[paused,false],[playing,true]]) {
      const r=await b.request('/api/listening-session',{method:'POST',body:JSON.stringify({token,playing:isPlaying})});assert.equal(r.status,204);
    }
    await b.maintain();
  }
  assert.equal((await info(b,paused)).buffer.personal.ready,0);
  await wait(b,async()=>((await info(b,playing)).buffer.personal.ready===2));
  // Resuming reuses the same anonymous session and replenishes its own queue.
  await b.request('/api/listening-session',{method:'POST',body:JSON.stringify({token:paused,playing:true})});
  await wait(b,async()=>((await info(b,paused)).buffer.personal.ready===2));
});

test('rapid skipping is limited per listener and old-client release never destroys shared cache',async t=>{
  const b=await startBackend(t,{serverMode:true,now:Date.now(),upstream:source([])});
  await wait(b,async()=>((await info(b)).buffer.ready===4));
  const a=await connect(b),other=await connect(b),first=await take(b,a,1);
  await b.request('/api/audio/played?id='+first.id,{method:'POST'});
  assert.equal((await b.request(first.streamUrl,{headers:{Range:'bytes=0-2'}})).status,206);
  for(let seq=2;seq<=6;seq++)await take(b,a,seq);
  const limited=await b.request('/api/song',{headers:{...headers(a),'X-Vinyl-Sequence':'7'}});
  assert.equal(limited.status,429);
  assert.ok((await take(b,other,1)).id);
  const crossOrigin=await b.request('/api/listening-session',{method:'POST',headers:{Origin:'https://other.example'}});
  assert.equal(crossOrigin.status,403);
});
