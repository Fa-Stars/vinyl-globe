'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startBackend } = require('../test-support/backend.cjs');

const privateDetail = 'https://api.jamendo.com/v3.0/tracks/?client_id=must-not-leak';

for (const [label, code, upstream] of [
  ['network failure', 'JAMENDO_NETWORK_ERROR', (_req, res) => res.destroy()],
  ['HTTP failure', 'JAMENDO_UPSTREAM_ERROR', (_req, res) => { res.writeHead(503); res.end(privateDetail); }],
  ['API rejection', 'JAMENDO_UPSTREAM_ERROR', (_req, res) => res.end(JSON.stringify({ headers: { status: 'failed', error_message: privateDetail }, results: [] }))],
  ['invalid JSON', 'JAMENDO_UPSTREAM_ERROR', (_req, res) => res.end(privateDetail)],
  ['missing range', 'JAMENDO_DISCOVERY_UNAVAILABLE', (_req, res) => res.end(JSON.stringify({ headers: { status: 'success' }, results: [] }))],
]) {
  test('song ' + label + ' returns a useful safe code even when credentials are configured', async t => {
    const backend = await startBackend(t, { catalogMaxId: 0, upstream });
    await backend.waitForOutput(/pool fetch failed/);
    const response = await backend.request('/api/song');
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
    assert.doesNotMatch(JSON.stringify(body), /client_id|must-not-leak|https?:\/\//);
    assert.doesNotMatch(backend.output, /client_id=must-not-leak/);
    const info = await (await backend.request('/api/info')).json();
    assert.equal(info.configured, true, 'configuration is not a connectivity check');
    assert.equal(info.songs, 0);
  });
}

test('an exact-ID upstream failure keeps its code through the discovery layer', async t => {
  const backend = await startBackend(t, { catalogMaxId: 1,
    upstream(_req, res) { res.writeHead(503); res.end(); },
  });
  await backend.waitForOutput(/pool fetch failed/);
  const response = await backend.request('/api/song');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'JAMENDO_UPSTREAM_ERROR');
});
