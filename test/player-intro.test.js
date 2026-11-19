'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayer } = require('../test-support/player.cjs');

async function setup(nextId = '2', nextHash = 'hash2', rangeResponse, selectionDelay) {
  const sources = [];
  const appended = [];
  class MediaSource extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/mpeg'; }
    static URL = class extends URL {
      static createObjectURL(source) { sources.push(source); return 'blob:test-' + sources.length; }
      static revokeObjectURL() {}
    };
    readyState = 'open';
    addSourceBuffer() {
      this.buffer = Object.assign(new EventTarget(), {
        buffered: { get length() { return Number(appended.length > 0); }, start: () => 0, end: () => 20 },
        appendBuffer(bytes) { appended.push(bytes); },
      });
      return this.buffer;
    }
  }
  const song = (id, hash = 'hash' + id) => ({ id, title: id, countrycode: 'US', streamUrl: '/audio/' + id,
    audioType: 'audio/mpeg', audioHash: hash });
  const player = await createPlayer({ mediaSource: MediaSource,
    infoResponse: respond => respond({ mode: 'distribution', configured: true, serverMode: true, personalQueues: true }),
    songResponse: async (i, _, respond) => {
      if (i > 1) await selectionDelay;
      return respond(i === 1 ? { ...song('1'), upNext: song('2') } : song(nextId, nextHash));
    },
    rangeResponse: rangeResponse || (() => new Response(new Uint8Array(262144), {
      status: 206, headers: { 'Content-Range': 'bytes 0-262143/500000' },
    })),
  });
  const openSource = async () => { sources.at(-1).dispatchEvent(new Event('sourceopen')); await player.flush(); };
  const intros = () => player.fetches.filter(req => req.url.startsWith('/audio/') && req.headers.Range === 'bytes=0-262143');
  return { player, openSource, intros, appended, sources };
}

test('distribution warms one prefix only after play and reuses those bytes on the confirmed selection', async () => {
  const { player, openSource, intros, appended } = await setup();
  await openSource();
  assert.deepEqual(intros().map(r => r.url), ['/audio/1']);
  await player.click('btn-play');
  await player.media('playing');
  await player.media('playing');
  assert.equal(player.songsRequested, 1);
  assert.deepEqual(intros().map(r => r.url), ['/audio/1', '/audio/2']);
  await player.click('btn-next');
  await openSource();
  assert.equal(player.title, '2');
  assert.equal(appended.length, 2);
  assert.equal(intros().length, 2);
  await player.pagehide();
});

test('a changed content hash discards the prediction before reading the confirmed version', async () => {
  const { player, openSource, intros } = await setup('2', 'replacement');
  await openSource();
  await player.click('btn-play');
  await player.media('playing');
  await player.click('btn-next');
  await openSource();
  const requests = intros().filter(r => r.url === '/audio/2');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].signal.aborted);
  assert.equal(requests[1].signal.aborted, false);
});

test('if a server ignores the range the player falls back to the original native URL', async () => {
  const { player, openSource, appended } = await setup('2', 'hash2', () => new Response('whole file'));
  await player.click('btn-play');
  await openSource();
  assert.equal(appended.length, 0);
  assert.equal(player.audio.src, '/audio/1');
  assert.equal(player.audio.paused, false);
});

test('a paced first response starts playback and feeds the decoder past 64 KiB without a second round trip', async () => {
  let firstBody, firstSize;
  const { player, openSource, appended, sources } = await setup('2', 'hash2', (_, { headers }) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    if (Number(start)) return new Promise(() => {}); // The next HTTP request is delayed.
    firstSize = Number(end) + 1;
    return new Response(new ReadableStream({ start(c) { firstBody = c; } }), {
      status: 206, headers: { 'Content-Range': 'bytes 0-' + end + '/500000' },
    });
  });
  await openSource();
  await player.click('btn-play');
  firstBody.enqueue(new Uint8Array(65536));
  if (firstSize === 65536) firstBody.close();
  await player.flush();
  assert.equal(appended.reduce((n, part) => n + part.byteLength, 0), 65536);
  sources[0].buffer.dispatchEvent(new Event('updateend'));
  if (firstSize > 65536) firstBody.enqueue(new Uint8Array(32768));
  await player.flush();
  assert.equal(appended.reduce((n, part) => n + part.byteLength, 0), 98304);
  await player.pagehide();
});

test('manual skip cancels an abandoned transfer while the new selection is pending', async () => {
  let confirm;
  const pending = new Promise(resolve => { confirm = resolve; });
  const { player, openSource, intros } = await setup('2', 'hash2', () => new Promise(() => {}), pending);
  await openSource();
  const original = intros()[0];
  assert.equal(original.signal.aborted, false);
  await player.click('btn-next');
  assert.ok(original.signal.aborted);
  assert.equal(player.title, '1');
  confirm();
  await player.flush();
  assert.equal(player.title, '2');
  assert.equal(intros().at(-1).signal.aborted, false);
});
