'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

const license = (name, url) => ({ name, url });
const track = (id, overrides = {}) => ({
  id: String(id),
  title: 'Track ' + id,
  artist: 'Artist ' + id,
  album: 'Album',
  artwork: '',
  duration: 180,
  streamUrl: '/audio/' + id,
  countrycode: 'US',
  country: '美国',
  sourceUrl: 'https://www.jamendo.com/track/' + id,
  license: license('CC BY-NC-SA 3.0', 'https://creativecommons.org/licenses/by-nc-sa/3.0/'),
  ...overrides,
});

test('a missing Jamendo credential stops autoplay without retrying the song request', async () => {
  const player = await createPlayer({
    demo: true,
    infoResponse: (response) => response({ mode: 'jamendo', configured: true }),
    songResponse: (_index, _signal, response) => response({
      code: 'JAMENDO_SETUP_REQUIRED',
      error: '请配置 Jamendo client_id',
    }, 503),
  });

  assert.equal(player.songsRequested, 1);
  assert.equal(player.audio.paused, true);
  assert.match(player.status, /Jamendo|client_id/);
  await player.tick(60000);
  assert.equal(player.songsRequested, 1);
  await player.click('btn-play');
  assert.equal(player.songsRequested, 1);
  assert.equal(player.audio.paused, true);
});

test('an explicit setup-required info response avoids starting a song request', async () => {
  const player = await createPlayer({
    demo: true,
    infoResponse: (response) => response({ mode: 'setup-required', configured: false }),
  });

  assert.equal(player.songsRequested, 0);
  assert.equal(player.audio.paused, true);
  assert.match(player.status, /配置|client_id/);
  await player.tick(60000);
  assert.equal(player.songsRequested, 0);
});

test('a transient info failure keeps Jamendo playback available', async () => {
  const player = await createPlayer({
    infoResponse: (response) => response({ error: 'temporary' }, 500),
  });

  assert.equal(player.title, 'Track 1');
  assert.ok(player.songsRequested >= 1);
  assert.equal(player.playbackMode, 'JAMENDO FULL TRACK');
});

test('track rights links switch with the song and reject unsafe or mismatched URLs', async () => {
  const player = await createPlayer({
    songResponse: (index, _signal, response) => response([
      track(1, { license: license('CC BY-ND 3.0', 'https://creativecommons.org/licenses/by-nd/3.0/') }),
      track(2, {
        sourceUrl: 'javascript:alert(1)',
        license: license('CC BY-NC-SA 3.0', 'https://evil.example/licenses/by-nc-sa/3.0/'),
      }),
      track(3, { license: license('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/') }),
    ][index - 1]),
  });
  const source = player.element('np-source-link');
  const licenseLink = player.element('np-license-link');

  assert.equal(source.textContent, '歌曲原页');
  assert.equal(source.href, 'https://www.jamendo.com/track/1');
  assert.equal(licenseLink.textContent, 'CC BY-ND 3.0');
  assert.equal(licenseLink.href, 'https://creativecommons.org/licenses/by-nd/3.0/');
  assert.match(player.element('np-meta').textContent, /Artist 1/);

  await player.click('btn-next');
  assert.equal(player.title, 'Track 2');
  assert.equal(source.hidden, true);
  assert.equal(source.href, '');
  assert.equal(licenseLink.hidden, true);
  assert.equal(licenseLink.href, '');

  await player.click('btn-next');
  assert.equal(player.title, 'Track 3');
  assert.equal(source.href, 'https://www.jamendo.com/track/3');
  assert.equal(licenseLink.textContent, 'CC BY 4.0');
  assert.equal(licenseLink.href, 'https://creativecommons.org/licenses/by/4.0/');
});

test('desktop settings passes a blank client id through to setup-required mode', async () => {
  const saved = [];
  const player = await createPlayer({
    electronAPI: {
      getSettings: async () => ({ jamendoClientId: 'configured', mode: 'jamendo', configured: true }),
      saveJamendoClientId: async (value) => {
        saved.push(value);
        return { ok: true, changed: true, mode: 'setup-required', configured: false };
      },
    },
  });

  await player.click('settings-button');
  const input = player.element('jamendo-client-id');
  input.value = '';
  await player.click('settings-save');
  assert.deepEqual(saved, ['']);
  assert.match(player.element('settings-status').textContent, /停用播放|刷新/);
});

test('an expired look-ahead candidate is released and replaced using the current clock', async () => {
  const player = await createPlayer({
    songResponse: (index, _signal, response) => response(track(index, {
      fetchedAt: index === 2 ? 0 : Number.MAX_SAFE_INTEGER,
    })),
  });

  await player.tick(15 * 60 * 1000 + 1);
  await player.click('btn-next');
  assert.equal(player.title, 'Track 3');
  assert.ok(player.songsRequested >= 3);
  assert.deepEqual(player.beacons.slice(0, 2), [
    '/api/audio/played?id=2',
    '/api/audio/played?id=1',
  ]);
});

test('an expired in-flight candidate is released before a fresh replacement is used', async () => {
  let finishSecond;
  const player = await createPlayer({
    songResponse: (index, _signal, response) => {
      if (index === 1) return response(track(index, { fetchedAt: Number.MAX_SAFE_INTEGER }));
      if (index === 2) return new Promise((resolve) => {
        finishSecond = () => resolve(response(track(index, { fetchedAt: -(15 * 60 * 1000 + 1) })));
      });
      return response(track(index, { fetchedAt: Number.MAX_SAFE_INTEGER }));
    },
  });

  const changing = player.click('btn-next');
  await player.flush();
  finishSecond();
  await changing;
  await player.flush();
  assert.equal(player.title, 'Track 3');
  assert.deepEqual(player.beacons.slice(0, 2), [
    '/api/audio/played?id=2',
    '/api/audio/played?id=1',
  ]);
});
