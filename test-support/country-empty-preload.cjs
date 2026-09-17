'use strict';

// Exercise the real discovery/ingestion path; only replace external responses.
const originalFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1') return originalFetch(input, options);
  if (url.hostname === 'api.jamendo.com' && url.pathname === '/v3.0/tracks/') {
    const results = (url.searchParams.get('id') || '').split('+')
      .filter(id => ['1', '2', '3'].includes(id))
      .map(id => ({
        id, name: 'Live Track ' + id,
        artist_name: id === '3' ? 'Another Artist' : 'Unverified Fixture Artist',
        artist_id: id === '3' ? '900003' : '900001',
        audio: 'https://example.test/' + id + '.mp3',
        license_ccurl: 'http://creativecommons.org/licenses/by-nc-sa/3.0/',
      }));
    return Promise.resolve(new Response(JSON.stringify({ headers: { status: 'success' }, results })));
  }
  if (url.hostname === 'example.test') return Promise.resolve(new Response('', { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify({ headers: { status: 'success' }, results: [], artists: [] })));
};
