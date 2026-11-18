'use strict';

// A client socket closing does not prove that the server has observed it yet.
// Expose that boundary for the abandoned-request regression test.
const http = require('node:http');
const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.on('request', (req, res) => {
    if (req.url !== '/api/song') return;
    console.log('[test] song request opened');
    res.once('close', () => console.log('[test] song request closed'));
  });
  return server;
};

// Replace only external network and the 12-hour clock; run the real HTTP server.
const fetchRemote = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1') return fetchRemote(input, options);
  const musicBrainz = url.hostname === 'musicbrainz.org';
  if (musicBrainz && process.env.WORLD_VINYL_TEST_MUSICBRAINZ_UPSTREAM !== '1') {
    return Promise.resolve(new Response(JSON.stringify({ artists: [] })));
  }
  if (url.hostname !== 'api.jamendo.com' && !musicBrainz) {
    return Promise.reject(new Error('Unexpected external request in test'));
  }
  const target = new URL(process.env.WORLD_VINYL_TEST_UPSTREAM);
  for (const [key, value] of url.searchParams) if (key !== 'client_id') target.searchParams.set(key,value);
  target.searchParams.set('source', url.hostname);
  target.searchParams.set('path', url.pathname);
  target.searchParams.set('offset', url.searchParams.get('offset') || '0');
  return fetchRemote(target, options);
};

const interval = global.setInterval;
// Exercise the production audio timeout without a minute-long regression test.
// Only test child processes opt into this accelerated timeout.
const audioTimeoutMs = Number(process.env.WORLD_VINYL_TEST_AUDIO_TIMEOUT_MS);
if (Number.isFinite(audioTimeoutMs) && audioTimeoutMs > 0) {
  const timeout = global.setTimeout;
  global.setTimeout = (callback, ms, ...args) =>
    timeout(callback, ms === 60000 ? audioTimeoutMs : ms, ...args);
}
let refresh;
let maintenance;
let testNow = Number(process.env.WORLD_VINYL_TEST_NOW);
if (Number.isFinite(testNow)) Date.now = () => testNow;
global.setInterval = (callback, ms, ...args) => {
  if (ms === 60000 && process.env.WORLD_VINYL_SERVER_MODE === '1') { maintenance = callback; return { unref() {} }; }
  if (ms !== 12 * 3600 * 1000) return interval(callback, ms, ...args);
  refresh = callback;
  return { unref() {} };
};
process.on('message', (message) => {
  if (message === 'maintenance' && maintenance) { Promise.resolve(maintenance()).then(() => process.send('maintenance-finished')); return; }
  if (message && message.type === 'clock' && Number.isFinite(message.now)) {
    testNow = message.now;
    Date.now = () => testNow;
    process.send?.({ type: 'clock-updated', now: testNow });
    return;
  }
  if (message !== 'refresh' || !refresh) return;
  const result = refresh();
  process.send('refresh-started');
  Promise.resolve(result).then(() => process.send('refresh-finished'));
});
