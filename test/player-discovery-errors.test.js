'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

test('a song connection failure explains the network problem without exposing upstream text', async () => {
  const player = await createPlayer({
    songResponse: (_index, _signal, response) => response({
      code: 'JAMENDO_NETWORK_ERROR', error: 'private-upstream-url-and-client-id',
    }, 503),
  });
  assert.match(player.status, /Jamendo.*网络|网络.*Jamendo/);
  assert.doesNotMatch(player.status, /private-upstream/);
  assert.equal(player.playbackMode, 'JAMENDO FULL TRACK', 'connectivity failure must not claim credentials are missing');
  assert.equal(player.audio.paused, true);
});

test('exhausting song retries preserves the underlying connection diagnosis', async () => {
  const player = await createPlayer({
    songResponse: (_index, _signal, response) => response({ code: 'JAMENDO_NETWORK_ERROR' }, 503),
  });
  await player.click('btn-play');
  await player.tick(60000);
  assert.match(player.status, /连续失败/);
  assert.match(player.status, /网络|DNS/);
  assert.equal(player.audio.paused, true);
  const attempts = player.songsRequested;
  await player.tick(60000);
  assert.equal(player.songsRequested, attempts, 'exhausted retries must stop');
});

test('an unavailable upstream API is distinguished from missing local credentials', async () => {
  const player = await createPlayer({
    songResponse: (_index, _signal, response) => response({ code: 'JAMENDO_UPSTREAM_ERROR' }, 503),
  });
  assert.match(player.status, /Jamendo.*服务/);
  assert.equal(player.playbackMode, 'JAMENDO FULL TRACK');
});

test('a failed background discovery does not interrupt the playing song', async () => {
  const player = await createPlayer({
    songResponse: (index, _signal, response) => index === 1 ? response({
      id: '1', title: 'Current Song', artist: 'Artist', streamUrl: '/audio/1', countrycode: 'FR',
    }) : response({ code: 'JAMENDO_NETWORK_ERROR' }, 503),
  });
  await player.click('btn-play');
  await player.media('playing');
  assert.equal(player.title, 'Current Song');
  assert.equal(player.audio.paused, false);
  assert.doesNotMatch(player.status, /DNS|网络/);
});
