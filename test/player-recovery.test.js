'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

test('automatic playback failures stop at eight and a manual action can retry', async () => {
  const player = await createPlayer();
  await player.click('btn-play');
  for (let i = 0; i < 8; i++) {
    await player.media('error');
    await player.tick(5000);
  }
  assert.match(player.status, /连续失败/);
  const stoppedAt = player.title;
  await player.tick(60000);
  assert.equal(player.title, stoppedAt);
  assert.equal(player.audio.paused, true);
  await player.click('btn-next');
  assert.notEqual(player.title, stoppedAt);
});

test('a stalled track recovers after playback has already started', async () => {
  const player = await createPlayer();
  await player.click('btn-play');
  player.audio.readyState = 4;
  await player.media('playing');
  const stalledTrack = player.title;
  player.audio.readyState = 2;
  await player.media('waiting');
  // Repeated buffering events must not postpone the same timeout forever.
  await player.tick(6000);
  await player.media('stalled');
  await player.tick(5000);
  assert.notEqual(player.title, stalledTrack);
});

test('pausing while buffering cancels all automatic recovery', async () => {
  const player = await createPlayer();
  await player.click('btn-play');
  await player.media('waiting');
  await player.click('btn-play');
  const pausedTrack = player.title;
  await player.tick(60000);
  assert.equal(player.title, pausedTrack);
  assert.equal(player.audio.paused, true);
});

function song(index) {
  return { id: String(index), title: 'Track ' + index, artist: '', artwork: '', duration: 180, streamUrl: '/audio/' + index, countrycode: 'US' };
}

test('rapid skips abort the superseded request and ignore its late response', async () => {
  const pending = new Map();
  const player = await createPlayer({
    songResponse(index, _signal, response) {
      if (index === 1) return response(song(index));
      return new Promise((resolve) => pending.set(index, () => resolve(response(song(index)))));
    },
  });
  await player.click('btn-next');
  await player.click('btn-next');
  assert.equal(player.requests[1].signal?.aborted, true);
  pending.get(3)();
  await player.flush();
  assert.equal(player.title, 'Track 3');
  pending.get(2)();
  await player.flush();
  assert.equal(player.title, 'Track 3');
  await player.click('btn-next');
  pending.get(4)();
  await player.flush();
  assert.equal(player.title, 'Track 4');
});

test('a hung song request times out instead of leaving the controls searching forever', async () => {
  const player = await createPlayer({
    songResponse(_index, signal) {
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  await player.tick(21000);
  assert.equal(player.requests[0].signal?.aborted, true);
  assert.match(player.status, /失败|超时/);
});

test('network recovery resumes requested playback but respects a manual pause', async () => {
  const player = await createPlayer();
  await player.click('btn-play');
  await player.network(false);
  await player.media('error');
  const interruptedTrack = player.title;
  await player.tick(60000);
  assert.equal(player.title, interruptedTrack);
  await player.network(true);
  assert.notEqual(player.title, interruptedTrack);
  await player.network(false);
  await player.media('error');
  await player.click('btn-play');
  const pausedTrack = player.title;
  await player.network(true);
  await player.tick(60000);
  assert.equal(player.title, pausedTrack);
  assert.equal(player.audio.paused, true);
});

test('blocked demo autoplay stays on the prepared track with a useful prompt', async () => {
  const player = await createPlayer({ demo: true, playError: { name: 'NotAllowedError' } });
  assert.match(player.status, /阻止自动播放/);
  const track = player.title;
  await player.tick(60000);
  assert.equal(player.title, track);
  assert.equal(player.audio.paused, true);
});

test('pausing a pending song change cancels the request and ignores its result', async () => {
  let complete;
  const player = await createPlayer({
    songResponse(index, _signal, response) {
      if (index === 1) return response(song(index));
      return new Promise((resolve) => { complete = () => resolve(response(song(index))); });
    },
  });
  await player.click('btn-next');
  await player.media('error'); // A late error from the old audio must not start a retry.
  await player.click('btn-play');
  assert.equal(player.requests[1].signal.aborted, true);
  complete();
  await player.flush();
  await player.tick(60000);
  assert.equal(player.title, 'Track 1');
  assert.match(player.status, /已暂停/);
  assert.equal(player.audio.paused, true);
});

test('normal progress and ended events sustain eight simulated hours of playback', async () => {
  const player = await createPlayer();
  assert.equal(player.audio.paused, true); // Opening the page must not autoplay.
  await player.click('btn-play');
  for (let track = 1; track <= 160; track++) {
    assert.equal(player.title, 'Track ' + track);
    player.audio.readyState = 4;
    await player.media('playing');
    for (let second = 10; second <= 180; second += 10) {
      player.audio.currentTime = second;
      await player.media('timeupdate');
      await player.tick(10000);
    }
    player.audio.ended = true;
    await player.media('ended');
    await player.tick(700);
  }
  assert.equal(player.title, 'Track 161');
  assert.equal(player.audio.paused, false);
});

test('late startup information does not overwrite an earlier user play action', async () => {
  let finishInfo;
  const player = await createPlayer({
    infoResponse(response) {
      return new Promise((resolve) => { finishInfo = () => resolve(response({ mode: 'itunes' })); });
    },
  });
  await player.click('btn-play');
  assert.equal(player.title, 'Track 1');
  finishInfo();
  await player.flush();
  assert.equal(player.title, 'Track 1');
  assert.equal(player.audio.paused, false);
});
