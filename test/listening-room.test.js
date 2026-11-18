'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

test('listening room keeps track metadata and transport in sync through play, pause and skip', async () => {
  const player = await createPlayer();
  assert.equal(player.element('np-artist').textContent, 'Artist');
  assert.equal(player.element('transport-title').textContent, player.title);
  assert.equal(player.element('header-status-text').textContent, '准备就绪');
  assert.match(player.element('transport-artwork').style.backgroundImage, /record-sleeve\.svg/);
  await player.click('btn-play');
  await player.media('playing');
  assert.equal(player.element('deck').classList.contains('playing'), true);
  assert.equal(player.element('header-status-text').textContent, '正在播放');
  await player.click('btn-play');
  assert.equal(player.element('deck').classList.contains('playing'), false);
  assert.equal(player.element('header-status-text').textContent, '已暂停');
  await player.click('btn-next');
  assert.equal(player.title, 'Track 2');
  assert.equal(player.element('transport-title').textContent, player.title);
  assert.equal(player.element('transport-artist').textContent, 'Artist');
});

test('country status changes from pending to unknown instead of claiming a lock', async () => {
  const player = await createPlayer({
    songResponse(index, _signal, response) {
      return response({ id: String(index), title: 'Unknown Region', artist: 'Unknown Artist', streamUrl: '/audio/' + index });
    },
    countryResponse(_url, _signal, response) { return response({ status: 'pending' }); },
  });
  assert.equal(player.element('globe-location-status').textContent, '正在定位');
  await player.tick(26000);
  assert.equal(player.element('globe-location-status').textContent, '未知地区');
  assert.doesNotMatch(player.element('globe-signal-copy').textContent, /LOCKED|已定位/);
  assert.equal(player.audio.paused, true);
});

test('the record is keyboard operable without starting playback twice', async () => {
  const player = await createPlayer();
  const key = (value) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value });
    player.element('record').dispatchEvent(event);
    return event;
  };
  assert.equal(key('Enter').defaultPrevented, true);
  await player.flush();
  assert.equal(player.audio.paused, false);
  assert.equal(key(' ').defaultPrevented, true);
  await player.flush();
  assert.equal(player.audio.paused, true);
});

for (const outcome of ['failure', 'success', 'reject']) {
  test('a pending settings save ' + outcome + ' stays attached until its result is known', async () => {
    let finish;
    const player = await createPlayer({
      electronAPI: {
        getSettings: async () => ({ jamendoClientId: 'original', mode: 'jamendo' }),
        saveJamendoClientId: () => new Promise((resolve, reject) => {
          finish = () => outcome === 'reject' ? reject(new Error('old failure')) :
            resolve(outcome === 'failure' ? { ok: false, error: 'old failure' } : { ok: true, mode: 'jamendo' });
        }),
      },
    });
    await player.click('settings-button');
    await player.click('settings-save');
    await player.click('settings-close');
    await player.click('settings-button');
    assert.equal(player.element('settings-modal').hidden, false);
    assert.equal(player.element('settings-close').disabled, true);
    assert.equal(player.element('jamendo-client-id').disabled, true);
    finish();
    await player.flush();
    await player.tick(400);
    if (outcome === 'success') {
      assert.equal(player.reloads, 1, 'successful settings always refresh the stale setup page');
    } else {
      assert.equal(player.reloads, 0);
      assert.equal(player.element('settings-save').disabled, false);
      assert.equal(player.element('settings-close').disabled, false);
      assert.equal(player.element('jamendo-client-id').disabled, false);
      await player.click('settings-close');
      assert.equal(player.element('settings-modal').hidden, true);
    }
  });
}

test('real HTML contains every literal player binding and keeps track rights in the footer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../web/public/index.html'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate IDs break DOM bindings');
  for (const [, id] of source.matchAll(/(?:getElementById|\bel)\('([^']+)'\)/g)) {
    assert.ok(ids.includes(id), 'missing DOM binding: ' + id);
  }
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  assert.match(footer, /id="np-source-link"/);
  assert.match(footer, /id="np-license-link"/);
  assert.match(html, /id="record"[^>]*role="button"/);
});
