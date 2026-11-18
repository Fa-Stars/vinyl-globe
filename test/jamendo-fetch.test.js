'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');
const { createJamendoFetch } = require('../web/jamendo-fetch');

const API = 'https://api.jamendo.com/v3.0/tracks/?client_id=test-private';
const AUDIO = 'https://prod-1.storage.jamendo.com/?trackid=42';
const connectionError = code => Object.assign(new TypeError('fetch failed'), { cause: { code } });

async function harness(t, { native, serve, answer, ...settings } = {}) {
  const calls = { direct: [], dns: [], secure: [] };
  const server = http.createServer(serve || ((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ headers: { status: 'success', code: 0 }, results: [{ id: '42' }] }));
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (['cloudflare-dns.com', 'dns.google'].includes(url.hostname)) {
      calls.dns.push(url);
      assert.doesNotMatch(url.href, /test-private|client_id|trackid/);
      if (answer) return answer(url, options);
      return new Response(JSON.stringify({ Status: 0, Answer: [
        { name: url.searchParams.get('name'), type: 1, TTL: 60, data: '104.26.12.43' },
      ] }));
    }
    calls.direct.push(url);
    if (native) return native(input, options);
    throw connectionError('ENOTFOUND');
  };
  function requestImpl(input, options, callback) {
    const url = new URL(input);
    calls.secure.push({ url, options });
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname.endsWith('.'), false, 'fallback retains a standard hostname');
    assert.equal(options.rejectUnauthorized, true, 'certificate validation stays enabled');
    assert.equal(options.servername || url.hostname, url.hostname);
    assert.equal(typeof options.agent?.createConnection, 'function', 'fallback uses the tested TLS record transport');
    assert.equal(typeof options.lookup, 'function', 'fallback connects to the secure DNS answer');
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [{ address: '104.26.12.43', family: 4 }]);
    });
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, '104.26.12.43');
      assert.equal(family, 4);
    });
    const checkIdentity = options.checkServerIdentity || require('node:tls').checkServerIdentity;
    assert.ok(checkIdentity(url.hostname, { subjectaltname: 'DNS:unrelated.example' }),
      'a certificate for another host is rejected');
    const local = new URL(url.pathname + url.search, 'http://127.0.0.1:' + server.address().port);
    return http.request(local, { method: options.method, headers: options.headers, signal: options.signal }, callback);
  }
  const request = createJamendoFetch({ fetchImpl, requestImpl, ...settings });
  return { request, calls, server };
}

test('ordinary Jamendo success uses the normal connection only', async t => {
  const { request, calls } = await harness(t, { native: async () => new Response('{"ok":true}') });
  assert.deepEqual(await (await request(API)).json(), { ok: true });
  assert.equal(calls.dns.length, 0);
  assert.equal(calls.secure.length, 0);
});

for (const code of ['ENOTFOUND', 'ECONNRESET', 'UND_ERR_SOCKET']) {
  test(code + ' recovers through secure DNS and standard TLS server names', async t => {
    const { request, calls } = await harness(t, { native: async () => { throw connectionError(code); } });
    const response = await request(API);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).headers.code, 0);
    assert.equal(calls.secure.length, 1);
    assert.equal(calls.secure[0].url.searchParams.get('client_id'), 'test-private');
    assert.equal(calls.dns[0].searchParams.get('name'), 'api.jamendo.com');
    await (await request(API)).body.cancel();
    assert.equal(calls.direct.length, 1, 'working fallback avoids repeated failed normal requests');
    assert.equal(calls.dns.length, 1, 'resolved address is cached within its DNS TTL');
  });
}

for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']) {
  test('certificate failure ' + code + ' is reported without a fallback', async t => {
    const original = connectionError(code);
    const { request, calls } = await harness(t, { native: async () => { throw original; } });
    await assert.rejects(request(API), error => error === original);
    assert.equal(calls.dns.length, 0);
    assert.equal(calls.secure.length, 0);
  });
}

test('HTTP authentication and rate errors do not trigger another path', async t => {
  for (const status of [401, 403, 429, 503]) {
    const { request, calls } = await harness(t, { native: async () => new Response('upstream', { status }) });
    assert.equal((await request(API)).status, status);
    assert.equal(calls.dns.length, 0);
  }
});

test('a caller abort never starts DNS or retries a cancelled request', async t => {
  const controller = new AbortController();
  const { request, calls } = await harness(t, { native: async () => {
    controller.abort();
    throw connectionError('ECONNRESET');
  } });
  await assert.rejects(request(API, { signal: controller.signal }));
  assert.equal(calls.dns.length, 0);
  assert.equal(calls.secure.length, 0);
});

test('non-Jamendo, HTTP, and lookalike hosts never enter the fallback', async t => {
  for (const url of ['https://musicbrainz.org/ws/2/artist/', 'http://api.jamendo.com/',
    'https://api.jamendo.com.evil.example/', 'https://api.jamendo.com:444/']) {
    const { request, calls } = await harness(t);
    await assert.rejects(request(url));
    assert.equal(calls.dns.length, 0, url);
    assert.equal(calls.secure.length, 0, url);
  }
});

test('Range and HEAD survive the real streaming bridge', async t => {
  const { request, calls } = await harness(t, { serve(req, res) {
    assert.equal(req.headers['accept-encoding'], 'identity');
    if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': '10' }); return res.end(); }
    assert.equal(req.headers.range, 'bytes=2-5');
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10' });
    res.end('2345');
  } });
  const audio = await request(AUDIO, { headers: { Range: 'bytes=2-5' } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await audio.text(), '2345');
  const head = await request(AUDIO, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(calls.secure[1].options.method, 'HEAD');
});

test('untrusted redirect cannot receive the API credential', async t => {
  const { request, calls } = await harness(t, { serve(_req, res) {
    res.writeHead(302, { Location: 'https://evil.example/?client_id=test-private' }); res.end();
  } });
  await assert.rejects(request(API));
  assert.equal(calls.secure.length, 1);
});

test('private or invalid DoH addresses never receive a secure request', async t => {
  for (const data of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.1', '192.168.1.1', '::1', 'not-an-ip']) {
    const { request, calls } = await harness(t, { answer: async url => new Response(JSON.stringify({
      Status: 0, Answer: [{ name: url.searchParams.get('name'), type: 1, TTL: 60, data }],
    })) });
    await assert.rejects(request(API));
    assert.equal(calls.secure.length, 0, data);
  }
});

test('cancelling fallback audio closes the real upstream socket', async t => {
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const { request } = await harness(t, { serve(_req, res) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.write('first bytes');
    const closed = once(res, 'close');
    opened({ closed });
  } });
  const response = await request(AUDIO);
  const { closed } = await ready;
  await response.body.cancel();
  let timeout;
  try {
    await Promise.race([closed, new Promise((_r, reject) => { timeout = setTimeout(() => reject(new Error('upstream was not closed')), 2000); })]);
  } finally { clearTimeout(timeout); }
});

test('a truncated fallback audio response fails instead of silently ending or retrying', async t => {
  const { request, calls } = await harness(t, { serve(_req, res) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '100' });
    res.write('partial');
    setTimeout(() => res.destroy(), 30);
  } });
  const response = await request(AUDIO);
  await assert.rejects(response.arrayBuffer());
  assert.equal(calls.secure.length, 1);
});

test('disabling the fallback preserves ordinary fetch failure', async t => {
  const { request, calls } = await harness(t, { enabled: false });
  await assert.rejects(request(API));
  assert.equal(calls.dns.length, 0);
});

test('a DNS answer expires while the working fallback route is still remembered', async t => {
  let time = 1000;
  const { request, calls } = await harness(t, { now: () => time });
  await (await request(API)).body.cancel();
  time += 59000;
  await (await request(API)).body.cancel();
  assert.equal(calls.dns.length, 1);
  time += 2000;
  await (await request(API)).body.cancel();
  assert.equal(calls.dns.length, 2);
});

test('an already aborted request cannot use a remembered fallback route', async t => {
  const { request, calls } = await harness(t);
  await (await request(API)).body.cancel();
  const before = calls.secure.length;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request(API, { signal: controller.signal }));
  assert.equal(calls.secure.length, before);
});

test('the short normal connection deadline ends after headers, allowing a long body', async t => {
  const { request, calls } = await harness(t, { directTimeoutMs: 15, native: async (_url, options) => {
    return new Response(new ReadableStream({ start(controller) {
      const abort = () => controller.error(new Error('body aborted after headers'));
      options.signal?.addEventListener('abort', abort, { once: true });
      setTimeout(() => {
        options.signal?.removeEventListener('abort', abort);
        controller.enqueue(new TextEncoder().encode('complete song'));
        controller.close();
      }, 60);
    } }));
  } });
  assert.equal(await (await request(AUDIO)).text(), 'complete song');
  assert.equal(calls.secure.length, 0);
});

test('a stalled normal connection is cancelled before trying the working fallback', async t => {
  const { request, calls } = await harness(t, { directTimeoutMs: 15,
    native: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal((await (await request(API)).json()).headers.code, 0);
  assert.equal(calls.direct.length, 1);
  assert.equal(calls.secure.length, 1);
});

test('CNAME resolution uses the requested owner chain and its shortest TTL', async t => {
  let time = 1000;
  const { request, calls } = await harness(t, { now: () => time, answer: async url => new Response(JSON.stringify({
    Status: 0, Answer: [
      { name: 'unrelated.example.', type: 1, TTL: 60, data: '8.8.8.8' },
      { name: url.searchParams.get('name') + '.', type: 5, TTL: 30, data: 'edge.example.' },
      { name: 'edge.example.', type: 1, TTL: 300, data: '104.26.12.43' },
    ],
  })) });
  await (await request(API)).body.cancel();
  time += 31000;
  await (await request(API)).body.cancel();
  assert.equal(calls.dns.length, 2, 'CNAME TTL expires before the A record TTL');
});

test('an unrelated public A record cannot substitute for the requested name', async t => {
  const { request, calls } = await harness(t, { answer: async () => new Response(JSON.stringify({
    Status: 0, Answer: [{ name: 'unrelated.example.', type: 1, TTL: 60, data: '104.26.12.43' }],
  })) });
  await assert.rejects(request(API));
  assert.equal(calls.secure.length, 0);
});

test('a remembered fallback does not bypass redirect checks by retrying ordinary fetch', async t => {
  let redirect = false;
  const { request, calls } = await harness(t, { serve(_req, res) {
    if (redirect) { res.writeHead(302, { Location: 'https://evil.example/' }); return res.end(); }
    res.end('ok');
  } });
  await (await request(API)).body.cancel();
  redirect = true;
  await assert.rejects(request(API));
  assert.equal(calls.direct.length, 1);
  assert.equal(calls.secure.length, 2);
});
