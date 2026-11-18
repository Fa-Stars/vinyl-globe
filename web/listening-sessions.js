'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// One owner for leases, queues and disk accounting. Sharing a file never means
// sharing playback position, queue consumption, or permission to delete it.
function createListeningRoom({ directory, discover, fetchAudio, prepare = async () => {},
  onSongs = () => {}, onRemove = () => {}, now = () => Date.now(), random = Math.random,
  maxSessions = 10, target = 2, reserve = 4, concurrency = 2,
  maxBytes = 1024 * 1024 * 1024, maxTrackBytes = 16 * 1024 * 1024, maxFiles = 48,
  ttl = 15 * 60000, renewAfter = 10 * 60000, sessionTtl = 2 * 60000, pauseAfter = 5 * 60000,
} = {}) {
  const songs = new Map(), sessions = new Map(), readers = new Map(), creations = new Map();
  const waiters = new Set();
  let standby = [], retiring = null, active = 0, discovering = false;
  let timer, retryAt = 0, failures = 0, turn = 0, stopped = false;
  const error = (code, status, message) => Object.assign(new Error(message || code), { code, status });
  const file = id => path.join(directory, id + '.mp3');
  const notify = () => { for (const wake of waiters) wake(); };
  const ready = id => { const r = songs.get(id); return !!r?.readyAt && now() - r.readyAt < ttl; };
  function pinned(id) {
    if (readers.get(id) || standby.includes(id) || retiring === id) return true;
    for (const s of sessions.values()) if (s.current === id || s.queue.includes(id)) return true;
    return false;
  }
  function remove(id) {
    const r = songs.get(id);
    if (!r || r.downloading || pinned(id)) return false;
    for (const suffix of ['', '.tmp']) {
      try { fs.unlinkSync(file(id) + suffix); } catch (e) { if (e.code !== 'ENOENT') return false; }
    }
    songs.delete(id); onRemove(id); return true;
  }
  function usage() {
    let bytes = 0, files = 0;
    try {
      for (const name of fs.readdirSync(directory)) {
        if (!/^[A-Za-z0-9_-]+\.mp3(?:\.tmp)?$/.test(name)) continue;
        try { bytes += fs.statSync(path.join(directory, name)).size; files++; } catch { /* concurrent stream */ }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { bytes, files };
  }
  function roomForDownload() {
    // Reserve the maximum possible size for every active writer, including
    // unknown Content-Length responses. Two writers cannot oversubscribe disk.
    const accounted = () => {
      const u = usage();
      let temporaryBytes = 0;
      for (const r of songs.values()) if (r.downloading) {
        try { temporaryBytes += fs.statSync(file(r.song.id)+'.tmp').size; } catch { /* not opened yet */ }
      }
      return { bytes: u.bytes - temporaryBytes + active * maxTrackBytes, files: u.files };
    };
    let u = accounted();
    for (const r of [...songs.values()].filter(r => !pinned(r.song.id) && !r.downloading)
      .sort((a,b) => a.usedAt - b.usedAt)) {
      if (u.bytes + maxTrackBytes <= maxBytes && u.files < maxFiles) break;
      remove(r.song.id); u = accounted();
    }
    return u.bytes + maxTrackBytes <= maxBytes && u.files + active < maxFiles;
  }
  function schedule(delay = 0) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; work(); }, delay);
    timer.unref?.();
  }
  function getSession(token) {
    const s = sessions.get(token);
    if (!s || now() - s.seenAt >= sessionTtl) {
      if (s) sessions.delete(token);
      throw error('SESSION_EXPIRED', 401);
    }
    return s;
  }
  function open(address = 'unknown') {
    maintain(false);
    const limit = creations.get(address);
    if (limit && now() - limit.at < 60000 && limit.count >= 12) throw error('SESSION_RATE_LIMIT', 429);
    if (sessions.size >= maxSessions) throw error('SESSION_CAPACITY', 503);
    creations.set(address, {at: limit && now()-limit.at < 60000 ? limit.at : now(),
      count: limit && now()-limit.at < 60000 ? limit.count+1 : 1});
    const token = randomUUID();
    sessions.set(token, {queue:[], current:null, history:[], seenAt:now(), actionAt:now(),
      playing:false, lastSeq:0, lastSong:null, pending:null, credits:6, creditAt:now()});
    schedule();
    return { token, target, heartbeatMs:20000, expiresInMs:sessionTtl };
  }
  function touch(token, {state = 'heartbeat', playing = false, id} = {}) {
    const s = getSession(token);
    if (state === 'disconnect') { sessions.delete(token); notify(); schedule(); return; }
    s.seenAt = now();
    if (playing || playing !== s.playing) s.actionAt = now();
    s.playing = playing;
    if (typeof id==='string' && songs.has(id)) s.current=id;
    if (!playing && now() - s.actionAt >= pauseAfter) s.queue = [];
    schedule();
  }
  function choose(excluded, cachedOnly = false) {
    const candidates = [...songs.values()].filter(r => !excluded.has(r.song.id) &&
      !r.failedUntil && now()-r.song.fetchedAt < renewAfter && (!cachedOnly || ready(r.song.id)));
    if (!candidates.length) return null;
    return candidates[Math.floor(random()*candidates.length)].song.id;
  }
  function fill(s) {
    if (!s.playing && now()-s.actionAt >= pauseAfter) { s.queue=[]; return; }
    s.queue = s.queue.filter(id => songs.has(id) && !songs.get(id).failedUntil &&
      now()-songs.get(id).song.fetchedAt < ttl);
    while (s.queue.length < target) {
      const id = choose(new Set([...s.queue, ...s.history, s.current]));
      if (!id) break;
      s.queue.push(id);
    }
  }
  function wanted(rotate = true) {
    const list = [...sessions.values()];
    if (list.length) { const shift=(rotate ? turn++ : turn) % list.length; list.push(...list.splice(0,shift)); }
    const jobs = [];
    // A waiting foreground request gets first service; then every first queued
    // song gets a turn before anyone's second queued song or the public reserve.
    for (const s of list) if (s.pending && s.queue[0]) jobs.push(s.queue[0]);
    for (let i=0; i<target; i++) for (const s of list) if (s.queue[i]) jobs.push(s.queue[i]);
    return [...new Set(jobs.concat(standby))];
  }
  function needsDiscovery() {
    return standby.length < reserve || [...sessions.values()].some(s =>
      (s.playing || now()-s.actionAt < pauseAfter) && s.queue.length < target);
  }
  function work() {
    if (stopped) return;
    for (const s of sessions.values()) fill(s);
    while (standby.length < reserve) {
      const id = choose(new Set([...standby, retiring]));
      if (!id) break;
      standby.push(id);
    }
    if (needsDiscovery() && !discovering && now() >= retryAt) {
      // Metadata and failed candidates are bounded as well as audio files.
      for (const r of songs.values()) if (songs.size >= 80 && !pinned(r.song.id)) remove(r.song.id);
      if (songs.size < 80) {
        discovering = true;
        Promise.resolve().then(() => discover(6, new Set(songs.keys()))).then(batch => {
          const fresh = batch.filter(s => /^[A-Za-z0-9_-]+$/.test(s.id) && !songs.has(s.id)).slice(0,6);
          if (!fresh.length) throw new Error('No new songs');
          for (const song of fresh) songs.set(song.id, {song:{...song,fetchedAt:now()},readyAt:0,usedAt:now(),received:0});
          onSongs(fresh); retryAt=0; schedule();
        }).catch(() => { retryAt=now()+15000; schedule(15000); })
          .finally(() => { discovering=false; notify(); });
      }
    }
    for (const id of wanted()) {
      const r = songs.get(id);
      if (active >= concurrency || now() < retryAt) break;
      if (!r || ready(id) || r.downloading || r.failedUntil || !roomForDownload()) continue;
      active++; r.downloading=new AbortController(); r.received=0;
      download(r).finally(() => { active--; r.downloading=null; notify(); schedule(); });
    }
  }
  async function download(r) {
    const id=r.song.id, tmp=file(id)+'.tmp', controller=r.downloading;
    const timeout=setTimeout(() => controller.abort(),120000);
    try {
      fs.mkdirSync(directory,{recursive:true});
      const response=await fetchAudio(r.song.streamUrl,controller.signal);
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Audio unavailable'); }
      const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      const length=Number(response.headers.get('content-length'));
      if ((type && !['audio/mpeg','audio/mp3','application/octet-stream'].includes(type)) || length>maxTrackBytes) {
        await response.body.cancel(); throw new Error('Invalid audio');
      }
      const limiter=new Transform({transform(chunk,encoding,done) {
        r.received+=chunk.length;
        done(r.received>maxTrackBytes ? new Error('Track size limit') : null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),limiter,fs.createWriteStream(tmp),{signal:controller.signal});
      if (!r.received) throw new Error('Empty audio');
      if (controller.signal.aborted) throw new Error('Cancelled');
      fs.renameSync(tmp,file(id));
      r.readyAt=now(); r.usedAt=now(); r.received=0; failures=0; retryAt=0;
      // Artwork and country lookups are optional once the complete audio is on disk.
      Promise.resolve().then(() => prepare(r.song)).catch(() => {});
      if (retiring && standby.filter(ready).length >= reserve) { retiring=null; }
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* no partial file */ }
      r.received=0; r.failedUntil=now()+ttl;
      standby=standby.filter(x=>x!==id);
      for (const s of sessions.values()) s.queue=s.queue.filter(x=>x!==id);
      if (retiring && ready(retiring)) { standby.push(retiring); retiring=null; }
      failures=Math.min(failures+1,6); retryAt=now()+Math.min(600000,15000*2**(failures-1));
      schedule(Math.max(0,retryAt-now()));
    } finally { clearTimeout(timeout); }
  }
  async function take(token, sequence, cancelled = () => false) {
    const s=getSession(token);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw error('INVALID_SEQUENCE',400);
    s.seenAt=now();
    if (sequence === s.lastSeq && s.lastSong) return s.lastSong;
    if (sequence < s.lastSeq) throw error('STALE_SEQUENCE',409);
    if (s.pending) {
      if (sequence === s.pending.seq) return s.pending.promise;
      throw error('SONG_REQUEST_PENDING',409);
    }
    s.credits=Math.min(6,s.credits+(now()-s.creditAt)/1000); s.creditAt=now();
    if (s.credits < 1) throw error('SONG_RATE_LIMIT',429);
    s.credits--; s.actionAt=now();
    const promise=(async () => {
      const deadline=Date.now()+25000;
      while (true) {
        if (cancelled() || sessions.get(token)!==s) throw error('REQUEST_CANCELLED',409);
        fill(s);
        const id=s.queue.find(ready) || choose(new Set([...s.history,s.current]),true);
        if (id) {
          const r=songs.get(id);
          s.queue=s.queue.filter(x=>x!==id); s.current=id;
          s.history.push(id); s.history=s.history.slice(-64);
          r.usedAt=now(); s.lastSeq=sequence; s.lastSong=r.song;
          schedule(); return r.song;
        }
        schedule();
        if (Date.now() >= deadline || (retryAt>now() && !active && !discovering)) throw error('BUFFER_PREPARING',503);
        await new Promise(resolve => {
          const timeout=setTimeout(wake,250);
          function wake() { clearTimeout(timeout); waiters.delete(wake); resolve(); }
          waiters.add(wake);
        });
      }
    })();
    s.pending={seq:sequence,promise};
    try { return await promise; } finally { if (s.pending?.promise===promise) s.pending=null; }
  }
  function release(token,id) {
    const s=getSession(token);
    // Releasing one listener's track must never unlink shared audio.
    if (s.current===id) s.current=null;
    schedule();
  }
  function maintain(run = true) {
    for (const [token,s] of sessions) {
      if (now()-s.seenAt>=sessionTtl) sessions.delete(token);
      else if (!s.playing && now()-s.actionAt>=pauseAfter) s.queue=[];
    }
    for (const [address,value] of creations) if (now()-value.at>=60000) creations.delete(address);
    // Cap address bookkeeping even on a publicly accessible endpoint.
    while (creations.size>1000) creations.delete(creations.keys().next().value);
    if (!retiring && standby.filter(ready).length===reserve) {
      const old=standby.find(id=>now()-songs.get(id).song.fetchedAt>=renewAfter);
      if (old) { retiring=old; standby=standby.filter(id=>id!==old); }
    }
    standby=standby.filter(id=>songs.has(id) && (!songs.get(id).readyAt || ready(id)));
    for (const r of songs.values()) {
      if (r.failedUntil && r.failedUntil<=now()) { r.failedUntil=0; }
      if (now()-r.song.fetchedAt>=ttl && !pinned(r.song.id)) remove(r.song.id);
    }
    if (run) { notify(); schedule(); }
  }
  return {
    open,touch,take,release,maintain,pinned,
    publicSong() {
      const id=standby.find(ready);
      if (!id) throw error('BUFFER_PREPARING',503);
      // Compatibility for old clients: a public reserve is reusable, not a
      // destructive dequeue. New pages always use personal sessions.
      standby.push(standby.shift());
      return songs.get(id).song;
    },
    song:id=>songs.get(id)?.song,
    isFresh:ready,
    read(id) { readers.set(id,(readers.get(id)||0)+1); return () => {
      const n=(readers.get(id)||1)-1; n ? readers.set(id,n) : readers.delete(id); schedule();
    }; },
    stats(token) {
      const s=token ? getSession(token) : null;
      const u=usage();
      return {target:reserve,ready:standby.filter(ready).length,downloading:active,
        queued:wanted(false).filter(id=>!ready(id)&&!songs.get(id)?.downloading).length,
        audioMaxBytes:maxBytes,audioBytes:u.bytes,audioFiles:u.files,
        sessions:sessions.size,maxSessions,perSessionTarget:target,downloadConcurrency:concurrency,
        ...(s?{personal:{ready:s.queue.filter(ready).length,target,ids:s.queue.filter(ready)}}:{})};
    },
    close() { stopped=true; clearTimeout(timer); for (const r of songs.values()) r.downloading?.abort(); notify(); },
  };
}

module.exports={createListeningRoom};
