'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPlayer}=require('../test-support/player.cjs');
const infoResponse=response=>response({mode:'jamendo',configured:true,serverMode:true,personalQueues:true});

test('server pages identify requests by session and sequence without consuming personal look-ahead',async()=>{
  const p=await createPlayer({infoResponse});
  assert.equal(p.title,'Track 1');assert.equal(p.songsRequested,1);
  const first=p.fetches.find(r=>r.url==='/api/song');
  assert.equal(first.headers['X-Vinyl-Session'],'test-session-token');
  assert.equal(first.headers['X-Vinyl-Sequence'],'1');
  await p.click('btn-next');assert.equal(p.title,'Track 2');assert.equal(p.songsRequested,2);
  const songs=p.fetches.filter(r=>r.url==='/api/song');
  assert.equal(songs[1].headers['X-Vinyl-Sequence'],'2');
  const release=p.fetches.find(r=>r.url==='/api/audio/played?id=1');
  assert.equal(release.headers['X-Vinyl-Session'],'test-session-token');
  assert.ok(!p.beacons.some(u=>u.startsWith('/api/audio/played')));
  await p.media('playing'); await p.tick(20001);
  const beats=p.fetches.filter(r=>r.url==='/api/listening-session' && r.body);
  assert.equal(JSON.parse(beats.at(-1).body).playing,true);
  await p.pagehide();assert.ok(p.beacons.includes('/api/listening-session'));
});

test('session creation has a deadline and capacity errors remain usable player feedback',async()=>{
  const busy=await createPlayer({infoResponse,sessionResponse:(_opts,response)=>response({code:'SESSION_CAPACITY'},503)});
  assert.equal(busy.songsRequested,0);assert.match(busy.status,/使用人数较多/);
  const hung=await createPlayer({infoResponse,sessionResponse:opts=>new Promise((_resolve,reject)=>{
    opts.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true});
  })});
  await hung.tick(5001);
  const request=hung.fetches.find(r=>r.url==='/api/listening-session');
  assert.equal(request.signal.aborted,true);assert.equal(hung.songsRequested,0);
});

test('bfcache navigation preserves a live session rather than announcing disconnect',async()=>{
  const p=await createPlayer({infoResponse});
  await p.pagehide(true);assert.ok(!p.beacons.includes('/api/listening-session'));
  await p.tick(20001);
  assert.ok(p.fetches.some(r=>r.url==='/api/listening-session' && r.body));
});

test('a server restart or expired session reconnects before retrying the requested song',async()=>{
  let connects=0;
  const p=await createPlayer({infoResponse,
    sessionResponse:(opts,response)=>opts.body ? response({},204) : response({token:'session-'+(++connects)}),
    songResponse:(i,_signal,response)=>i===2 ? response({code:'SESSION_EXPIRED'},401) :
      response({id:String(i),title:'Track '+i,artist:'Artist',streamUrl:'/audio/'+i,countrycode:'US'}),
  });
  await p.click('btn-next');
  assert.equal(p.title,'Track 3');assert.equal(connects,2);
  const last=p.fetches.filter(r=>r.url==='/api/song').at(-1);
  assert.equal(last.headers['X-Vinyl-Session'],'session-2');assert.equal(last.headers['X-Vinyl-Sequence'],'1');
});

test('a timed-out mode check retries and adopts personal queues without interrupting current playback',async()=>{
  let checks=0;
  const p=await createPlayer({infoResponse:(response,signal)=>{
    if(++checks>1)return infoResponse(response);
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
  }});
  await p.tick(3001);assert.equal(p.title,'Track 1');
  await p.click('btn-play');const before=p.title;
  await p.tick(5001);assert.equal(checks,2);assert.equal(p.title,before);assert.equal(p.audio.paused,false);
  assert.ok(p.fetches.some(r=>r.url==='/api/listening-session'));
  await p.click('btn-next');
  const request=p.fetches.filter(r=>r.url==='/api/song').at(-1);
  assert.equal(request.headers['X-Vinyl-Session'],'test-session-token');
  assert.equal(request.headers['X-Vinyl-Sequence'],'1');
});

test('a late expired heartbeat cannot erase a replacement session',async()=>{
  let connects=0,finishOldHeartbeat;
  const p=await createPlayer({infoResponse,
    sessionResponse:(opts,response)=>{
      if(!opts.body)return response({token:'session-'+(++connects)});
      if(!finishOldHeartbeat)return new Promise(resolve=>{finishOldHeartbeat=()=>resolve(response({},401));});
      return response({},204);
    },
    songResponse:(i,_signal,response)=>i===2 ? response({code:'SESSION_EXPIRED'},401) :
      response({id:String(i),title:'Track '+i,artist:'Artist',streamUrl:'/audio/'+i,countrycode:'US'}),
  });
  await p.click('btn-next');assert.equal(connects,2);
  finishOldHeartbeat();await p.flush();await p.click('btn-next');
  assert.equal(connects,2);
  assert.equal(p.fetches.filter(r=>r.url==='/api/song').at(-1).headers['X-Vinyl-Session'],'session-2');
});
