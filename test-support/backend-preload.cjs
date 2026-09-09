'use strict';

// Replace only external network and the 12-hour clock; run the real HTTP server.
const fetchRemote = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1') return fetchRemote(input, options);
  if (url.hostname === 'musicbrainz.org') {
    return Promise.resolve(new Response(JSON.stringify({ artists: [] })));
  }
  if (!['api.jamendo.com', 'itunes.apple.com'].includes(url.hostname)) {
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
let refresh;
global.setInterval = (callback, ms, ...args) => {
  if (ms !== 12 * 3600 * 1000) return interval(callback, ms, ...args);
  refresh = callback;
  return { unref() {} };
};
process.on('message', (message) => {
  if (message !== 'refresh' || !refresh) return;
  const result = refresh();
  process.send('refresh-started');
  Promise.resolve(result).then(() => process.send('refresh-finished'));
});
