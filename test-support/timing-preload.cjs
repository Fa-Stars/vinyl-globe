'use strict';
const originalFetch = global.fetch;
global.fetch = async (input, options) => {
  const url = new URL(input);
  const started = performance.now();
  try {
    const response = await originalFetch(input, options);
    console.log('[timing] ' + JSON.stringify({
      host: url.hostname, path: url.pathname,
      kind: url.searchParams.get('order') === 'id_desc' ? 'catalog-boundary' : 'request',
      offset: url.searchParams.get('offset'),
      ms: Math.round(performance.now() - started), status: response.status,
    }));
    return response;
  } catch (error) {
    console.log('[timing] ' + JSON.stringify({ host: url.hostname, path: url.pathname, ms: Math.round(performance.now() - started), error: error.name }));
    throw error;
  }
};
