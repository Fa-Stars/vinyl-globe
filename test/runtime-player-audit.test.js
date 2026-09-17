'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

function song(index) {
  return {
    id: String(index),
    title: 'Track ' + index,
    artist: 'Artist ' + index,
    artwork: '',
    duration: 180,
    streamUrl: '/audio/' + index,
    countrycode: 'US',
  };
}

test('a late settings load cannot overwrite credentials in a reopened dialog', async () => {
  const pending = [];
  const player = await createPlayer({
    electronAPI: {
      getSettings: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      saveJamendoClientId: async () => ({ ok: true }),
    },
  });

  await player.click('settings-button');
  assert.equal(pending.length, 1);
  await player.click('settings-close');
  await player.click('settings-button');
  assert.equal(pending.length, 2);

  pending[1].resolve({ jamendoClientId: 'new', mode: 'jamendo', configured: true });
  await player.flush();
  const input = player.element('jamendo-client-id');
  input.value = 'user-edited';

  pending[0].resolve({ jamendoClientId: 'old', mode: 'jamendo', configured: true });
  await player.flush();

  assert.equal(input.value, 'user-edited');
  assert.equal(input.disabled, false);
  assert.equal(player.element('settings-save').disabled, false);
});

test('a late settings load failure cannot clobber a reopened dialog', async () => {
  const pending = [];
  const player = await createPlayer({
    electronAPI: {
      getSettings: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      saveJamendoClientId: async () => ({ ok: true }),
    },
  });

  await player.click('settings-button');
  await player.click('settings-close');
  await player.click('settings-button');
  pending[1].resolve({ jamendoClientId: 'new', mode: 'jamendo', configured: true });
  await player.flush();
  player.element('jamendo-client-id').value = 'user-edited';

  pending[0].reject(new Error('late settings failure'));
  await player.flush();

  assert.equal(player.element('jamendo-client-id').value, 'user-edited');
  assert.doesNotMatch(player.element('settings-status').textContent, /读取设置失败/);
});

test('a superseded parsed song is released after rapid next actions', async () => {
  let finishSecond;
  const player = await createPlayer({
    songResponse(index, _signal, response) {
      if (index === 2) {
        // Headers have already arrived; cancellation races with body parsing.
        return { ...response(song(index)), json: () => new Promise((resolve) => {
          finishSecond = () => resolve(song(index));
        }) };
      }
      return response(song(index));
    },
  });

  await player.click('btn-next');
  await player.click('btn-next');
  assert.equal(player.requests[1].signal.aborted, true);
  assert.equal(player.title, 'Track 3');

  finishSecond();
  await player.flush();

  assert.equal(player.title, 'Track 3');
  assert.ok(player.beacons.includes('/api/audio/played?id=2'));
});

test('adopting a prefetched song does not release the adopted audio', async () => {
  let finishSecond;
  const player = await createPlayer({
    songResponse(index, _signal, response) {
      if (index === 2) return new Promise(resolve => {
        finishSecond = () => resolve(response(song(index)));
      });
      return response(song(index));
    },
  });

  assert.equal(player.title, 'Track 1');
  assert.equal(player.songsRequested, 2);
  await player.click('btn-next');
  assert.equal(player.requests[1].signal.aborted, false);
  finishSecond();
  await player.flush();

  assert.equal(player.title, 'Track 2');
  assert.deepEqual(player.beacons, ['/api/audio/played?id=1']);
});
