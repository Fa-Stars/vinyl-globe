'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

function track(index, countrycode = '') {
  return {
    id: String(index), title: 'Track ' + index, artist: 'Artist ' + index,
    artwork: '', duration: 180, streamUrl: '/audio/' + index, countrycode,
  };
}

function untilAborted(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('slow globe resources load in parallel without delaying the first prepared song', async () => {
  const player = await createPlayer({
    mapResponse: (_response, signal) => untilAborted(signal),
    capitalsResponse: (_response, signal) => untilAborted(signal),
  });

  assert.ok(player.fetches.some(request => request.url === 'map.json'));
  assert.ok(player.fetches.some(request => request.url === 'capitals.json'));
  assert.equal(player.title, 'Track 1');
  assert.equal(player.audio.paused, true);
});

test('a hung mode check has a deadline and then allows song preparation', async () => {
  const player = await createPlayer({
    infoResponse: (_response, signal) => untilAborted(signal),
  });

  assert.equal(player.songsRequested, 0);
  await player.tick(3001);
  assert.equal(player.fetches.find(request => request.url === '/api/info').signal.aborted, true);
  assert.equal(player.title, 'Track 1');
  assert.equal(player.audio.paused, true);
});

test('an explicit missing-credential response still prevents songs while map requests are pending', async () => {
  const player = await createPlayer({
    mapResponse: (_response, signal) => untilAborted(signal),
    capitalsResponse: (_response, signal) => untilAborted(signal),
    infoResponse: response => response({ mode: 'setup-required', configured: false }),
  });

  assert.equal(player.songsRequested, 0);
  assert.equal(player.playbackMode, 'SETUP REQUIRED');
});

test('a mode-check timeout and late response preserve an earlier user play action', async () => {
  let finishInfo;
  const player = await createPlayer({
    infoResponse(response, signal) {
      return new Promise((resolve, reject) => {
        finishInfo = () => resolve(response({ mode: 'setup-required', configured: false }));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  await player.click('btn-play');
  await player.tick(3001);
  finishInfo();
  await player.flush();
  assert.equal(player.title, 'Track 1');
  assert.equal(player.audio.paused, false);
  assert.equal(player.playbackMode, 'JAMENDO FULL TRACK');
});

test('late globe resources focus the already prepared song without replacing it', async () => {
  let finishMap;
  let finishCapitals;
  const player = await createPlayer({
    mapResponse(response) {
      return new Promise(resolve => { finishMap = () => resolve(response({ w: 2, h: 1, grid: 'US..', names: {}, aliases: {} })); });
    },
    capitalsResponse(response) {
      return new Promise(resolve => { finishCapitals = () => resolve(response({ US: [38, -77] })); });
    },
  });

  assert.equal(player.title, 'Track 1');
  finishMap();
  await player.flush();
  player.frame(0);
  player.frame(1000 / 30);
  assert.ok(player.globeRotation < 0, 'late map should focus the current US track instead of idle rotation');
  finishCapitals();
  await player.flush();
  assert.equal(player.element('globe-lat').textContent, '38.0°N');
  assert.equal(player.element('globe-lon').textContent, '77.0°W');
  assert.equal(player.title, 'Track 1');
  assert.equal(player.songsRequested, 2);
});

test('switching songs cancels the previous country request and ignores a late country result', async () => {
  const pending = [];
  const player = await createPlayer({
    songResponse: (index, _signal, response) => response(track(index)),
    countryResponse(url, signal, response) {
      return new Promise(resolve => pending.push({
        signal,
        finish: () => resolve(response({ id: new URL(url, 'http://localhost').searchParams.get('id'), countrycode: 'FR', country: '法国' })),
      }));
    },
  });

  for (let i = 0; i < 5; i++) await player.click('btn-next');
  assert.equal(pending.length, 6);
  assert.ok(pending.slice(0, -1).every(request => request.signal?.aborted));
  assert.equal(pending.at(-1).signal.aborted, false);
  pending[0].finish();
  await player.flush();
  assert.equal(player.element('np-country').textContent, '🌐 正在定位…');
  pending.at(-1).finish();
  await player.flush();
  assert.equal(player.element('np-country').textContent, '🇫🇷 法国');
});

test('a stalled country request times out and a later lookup can complete', async () => {
  let calls = 0;
  const player = await createPlayer({
    songResponse: (index, _signal, response) => response(track(index)),
    countryResponse(url, signal, response) {
      if (++calls === 1) return untilAborted(signal);
      return response({ id: '1', countrycode: 'FR', country: '法国' });
    },
  });

  await player.tick(7501);
  assert.equal(calls, 2);
  assert.equal(player.element('np-country').textContent, '🇫🇷 法国');
  assert.equal(player.title, 'Track 1');
});

test('switching songs clears a pending country retry for the old song', async () => {
  const ids = [];
  const player = await createPlayer({
    songResponse: (index, _signal, response) => response(track(index, index > 1 ? 'US' : '')),
    countryResponse(url, _signal, response) {
      ids.push(new URL(url, 'http://localhost').searchParams.get('id'));
      return response({ status: 'pending' });
    },
  });

  await player.tick(1000);
  await player.click('btn-next');
  await player.tick(5000);
  assert.deepEqual(ids, ['1']);
  assert.equal(player.title, 'Track 2');
});

test('server standby owns look-ahead; the browser does not reserve another song until next is requested',async()=>{
 const player=await createPlayer({infoResponse:reply=>reply({mode:'jamendo',configured:true,serverMode:true})});
 assert.equal(player.songsRequested,1);
 await player.click('btn-play');await player.media('playing');await player.flush();
 assert.equal(player.songsRequested,1);
 await player.click('btn-next');await player.flush();
 assert.equal(player.songsRequested,2);
});
