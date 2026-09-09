const originalFetch = global.fetch;
global.fetch = (url, options) => new URL(url).hostname === '127.0.0.1'
  ? originalFetch(url, options)
  : Promise.resolve(new Response(JSON.stringify({headers:{status:'success'},results:[],artists:[]})));
