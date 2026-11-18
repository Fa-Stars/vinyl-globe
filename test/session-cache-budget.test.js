'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createListeningRoom}=require('../web/listening-sessions');

async function fixture(t,{oversize=false,prepare}={}) {
  const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'vinyl-budget-'));
  let count=0,inflight=0,peak=0,clock=Date.now();
  const room=createListeningRoom({directory,prepare,reserve:2,target:2,maxSessions:2,concurrency:2,
    maxBytes:8*1024,maxTrackBytes:1024,maxFiles:8,now:()=>clock,
    discover:async n=>Array.from({length:n},()=>({id:String(++count),streamUrl:'https://audio.example/'+count,fetchedAt:clock})),
    fetchAudio:async(_url,signal)=>{
      inflight++;peak=Math.max(peak,inflight);
      return new Response(new ReadableStream({async start(controller) {
        try {
          for(let i=0;i<(oversize?4:3);i++) {
            await new Promise(r=>setTimeout(r,4));
            if(signal.aborted) break;
            controller.enqueue(new Uint8Array(300));
          }
          controller.close();
        } catch { /* pipeline cancelled an oversized response */ }
        finally { inflight--; }
      }}),{headers:{'Content-Type':'audio/mpeg'}});
    },
  });
  t.after(()=>{room.close(); const relative=path.relative(fs.realpathSync(os.tmpdir()),fs.realpathSync(directory));
    if(!relative || relative.startsWith('..') || path.isAbsolute(relative))throw new Error('Unsafe cleanup');
    fs.rmSync(directory,{recursive:true,force:true});});
  return {room,directory,get peak(){return peak;},advance(ms){clock+=ms;}};
}
async function wait(predicate) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {if(predicate())return;await new Promise(r=>setTimeout(r,3));}
  assert.fail('Cache did not converge');
}

test('complete audio can be selected while artwork or country lookups are pending', async t => {
  let rejectMetadata;
  const metadata = new Promise((_, reject) => { rejectMetadata = reject; });
  const { room } = await fixture(t, { prepare: () => metadata });
  room.maintain();
  await wait(() => room.stats().ready === 2);
  const song = await room.take(room.open().token, 1);
  rejectMetadata(new Error('Artwork unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(room.isFresh(song.id));
});

test('parallel unknown-length writers respect the total disk budget including temporary files',async t=>{
  const f=await fixture(t),{room}=f;
  room.maintain();await wait(()=>room.stats().ready===2);
  const a=room.open('a').token,b=room.open('b').token;
  await room.take(a,1);await room.take(b,1);
  for(let sequence=2;sequence<=6;sequence++) {
    await wait(()=>room.stats(a).personal.ready===2 && room.stats(b).personal.ready===2);
    await Promise.all([room.take(a,sequence),room.take(b,sequence)]);
    for(let poll=0;poll<8;poll++) {
      const s=room.stats();assert.ok(s.audioBytes<=8*1024);assert.ok(s.audioFiles<=8);assert.ok(s.downloading<=2);
      await new Promise(r=>setTimeout(r,3));
    }
    f.advance(1000);
  }
  assert.equal(f.peak,2);
});

test('oversized unknown-length audio is rejected, partial files removed and retries back off',async t=>{
  const {room,directory}=await fixture(t,{oversize:true});room.maintain();
  await wait(()=>room.stats().downloading===2);
  await wait(()=>room.stats().downloading===0);
  assert.equal(room.stats().ready,0);assert.deepEqual(fs.readdirSync(directory),[]);
  for(let i=0;i<5;i++)room.maintain();
  await new Promise(r=>setTimeout(r,30));assert.equal(room.stats().downloading,0);
});

test('disconnecting a listener cannot evict a shared file while another read is open',async t=>{
  const f=await fixture(t),{room}=f;room.maintain();await wait(()=>room.stats().ready===2);
  const token=room.open().token,song=await room.take(token,1),finish=room.read(song.id);
  room.touch(token,{state:'disconnect'});f.advance(16*60000);room.maintain();
  assert.equal(fs.existsSync(path.join(f.directory,song.id+'.mp3')),true);
  finish();room.maintain();
  assert.equal(fs.existsSync(path.join(f.directory,song.id+'.mp3')),false);
});
