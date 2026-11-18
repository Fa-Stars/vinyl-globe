'use strict';
const assert = require('node:assert/strict');
const https = require('node:https');
const net = require('node:net');
const test = require('node:test');
const { once } = require('node:events');
const { createJamendoAgent, ClientHelloRecords } = require('../web/jamendo-tls');

const HOST = 'api.jamendo.com';
const HRR_RANDOM = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex');
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function handshake(type, body) { const h = Buffer.alloc(4); h[0] = type; h.writeUIntBE(body.length, 1, 3); return Buffer.concat([h, body]); }
function record(body, type = 22) { return Buffer.concat([Buffer.from([type, 3, 3]), u16(body.length), body]); }
function hello(name = HOST) {
  const text = Buffer.from(name);
  const entry = Buffer.concat([Buffer.from([0]), u16(text.length), text]);
  const list = Buffer.concat([u16(entry.length), entry]);
  const sni = Buffer.concat([u16(0), u16(list.length), list]);
  return handshake(1, Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]),
    u16(2), Buffer.from([0x13, 1, 1, 0]), u16(sni.length), sni]));
}
function serverHello(random = Buffer.alloc(32, 7)) {
  return record(handshake(2, Buffer.concat([Buffer.from([3, 3]), random, Buffer.from([0, 0x13, 1, 0]), u16(0)])));
}
function payloads(packets) { return Buffer.concat(packets.map(p => p.subarray(5))); }

for (const split of [false, true]) {
  test('ClientHello payload remains identical with ' + (split ? 'fragmented' : 'whole') + ' writes', () => {
    const transformer = new ClientHelloRecords(HOST);
    const payload = hello();
    const packet = record(payload);
    const chunks = split ? Array.from(packet, byte => Buffer.from([byte])) : [packet];
    const output = chunks.flatMap(chunk => transformer.send(chunk));
    assert.equal(output.length, 2);
    assert.deepEqual(payloads(output), payload);
    const cut = output[0].length - 5;
    const at = payload.indexOf(HOST);
    assert.ok(cut > at && cut < at + HOST.length, 'record boundary divides the unchanged SNI');
    transformer.assertFlushed();
  });
}

test('ClientHello split across existing TLS records preserves every payload byte', () => {
  const transformer = new ClientHelloRecords(HOST);
  const payload = hello();
  const input = Buffer.concat([record(payload.subarray(0, 9)), record(payload.subarray(9))]);
  const output = [...transformer.send(input.subarray(0, 7)), ...transformer.send(input.subarray(7))];
  assert.deepEqual(payloads(output), payload);
  assert.equal(output.length, 3);
});

test('a HelloRetryRequest split across TLS records and writes splits the second ClientHello too', () => {
  const transformer = new ClientHelloRecords(HOST);
  const payload = hello();
  transformer.send(record(payload));
  const message = serverHello(HRR_RANDOM).subarray(5);
  const retry = Buffer.concat([record(message.subarray(0, 17)), record(message.subarray(17))]);
  for (const byte of retry) transformer.receive(Buffer.from([byte]));
  const second = transformer.send(record(payload));
  assert.equal(second.length, 2);
  assert.deepEqual(payloads(second), payload);
});

test('real ServerHello stops plaintext observation before TLS 1.2 encrypted Finished', () => {
  const transformer = new ClientHelloRecords(HOST);
  transformer.send(record(hello()));
  const encrypted = record(Buffer.from([2, 255, 255, 255, 3, 4, 5, 6]));
  const input = Buffer.concat([serverHello(), record(Buffer.from([1]), 20), encrypted]);
  assert.doesNotThrow(() => transformer.receive(input));
  assert.doesNotThrow(() => transformer.receive(encrypted));
  transformer.markSecure();
  const application = Buffer.alloc(2 * 1024 * 1024, 0xa5);
  assert.deepEqual(transformer.send(application), [application]);
});

test('buffer limits reject oversized record and handshake declarations without waiting for more bytes', () => {
  const oversizedRecord = Buffer.from([22, 3, 3, 255, 255]);
  assert.throws(() => new ClientHelloRecords(HOST).send(oversizedRecord), /limit|exceeds/i);
  assert.throws(() => new ClientHelloRecords(HOST).receive(oversizedRecord), /limit|exceeds/i);
  assert.throws(() => new ClientHelloRecords(HOST).send(record(Buffer.from([1, 255, 255, 255]))), /limit|exceeds/i);
  assert.throws(() => new ClientHelloRecords(HOST).receive(record(Buffer.from([2, 255, 255, 255]))), /limit|exceeds/i);
  assert.throws(() => new ClientHelloRecords(HOST).send(Buffer.alloc(1024 * 1024)), /limit|exceeds/i);
  assert.throws(() => new ClientHelloRecords(HOST).receive(Buffer.alloc(1024 * 1024)), /limit|exceeds/i);
});

test('incomplete or unexpected SNI data fails instead of changing the ClientHello', () => {
  const transformer = new ClientHelloRecords(HOST);
  transformer.send(Buffer.from([22, 3]));
  assert.throws(() => transformer.assertFlushed(), /incomplete/i);
  assert.throws(() => new ClientHelloRecords(HOST).send(record(hello('unrelated.example'))), /SNI/i);
  assert.throws(() => new ClientHelloRecords(HOST).send(record(hello(HOST + '.'))), /SNI/i);
});

test('empty handshake records cannot grow the retained ClientHello list without bound', () => {
  const transformer = new ClientHelloRecords(HOST);
  const empty = record(Buffer.alloc(0));
  assert.throws(() => {
    for (let index = 0; index < 60000; index++) transformer.send(empty);
  }, /limit|exceeds/i);
});

async function secureServer(t, options = {}) {
  const { key, cert } = require('../test-support/tls-fixture.cjs');
  const server = https.createServer({ key, cert, ...options }, (_req, res) => res.end('unused'));
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.removeAllListeners('request');
  return { server, cert };
}
function readRequest(agent, server, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: HOST, port: server.address().port, path: '/', agent, ...options }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ response: res, body: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.once('error', reject);
  });
}

for (const version of ['TLSv1.2', 'TLSv1.3']) {
  test(version + ' local handshake verifies the ordinary SNI and streams a long body', async t => {
    const { server, cert } = await secureServer(t, { minVersion: version, maxVersion: version });
    const expected = Buffer.alloc(512 * 1024, 0x61);
    let observedName;
    server.on('secureConnection', socket => { observedName = socket.servername; });
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'Content-Length': expected.length });
      let offset = 0;
      const write = () => {
        while (offset < expected.length) {
          const end = Math.min(offset + 8192, expected.length);
          const chunk = expected.subarray(offset, end); offset = end;
          if (!res.write(chunk)) { res.once('drain', write); return; }
        }
        res.end();
      };
      write();
    });
    const agent = createJamendoAgent('127.0.0.1');
    t.after(() => agent.destroy());
    const { response, body } = await readRequest(agent, server, { ca: cert, minVersion: version, maxVersion: version });
    assert.equal(observedName, HOST);
    assert.equal(response.socket?.authorized ?? true, true);
    assert.deepEqual(body, expected);
  });
}

test('a paused slow consumer drains the complete body after the raw socket FIN', async t => {
  const { server, cert } = await secureServer(t);
  const expected = 3 * 1024 * 1024;
  server.on('request', (_req, res) => {
    res.writeHead(200, { 'Content-Length': expected, Connection: 'close' });
    res.end(Buffer.alloc(expected, 0x61));
  });
  const agent = createJamendoAgent('127.0.0.1');
  t.after(() => agent.destroy());
  const bytes = await new Promise((resolve, reject) => {
    const req = https.get({ hostname: HOST, port: server.address().port, agent, ca: cert }, async res => {
      res.pause();
      // An immediate listener also catches failure while the reader is paused.
      res.once('error', reject);
      try {
        await new Promise(resolve => setTimeout(resolve, 150));
        let received = 0;
        for await (const chunk of res) {
          received += chunk.length;
          await new Promise(resolve => setTimeout(resolve, 3));
        }
        resolve(received);
      } catch (error) { reject(error); }
    });
    req.once('error', reject);
  });
  assert.equal(bytes, expected);
});

test('a real TLS 1.3 HelloRetryRequest splits both ClientHellos and completes the response', async t => {
  const { server, cert } = await secureServer(t, {
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ecdhCurve: 'P-256',
  });
  const expected = Buffer.alloc(64 * 1024, 0x62);
  server.on('request', (_req, res) => res.end(expected));
  let clientHellos = 0;
  const send = ClientHelloRecords.prototype.send;
  ClientHelloRecords.prototype.send = function (chunk) {
    const packets = send.call(this, chunk);
    clientHellos += packets.filter(packet => packet[0] === 22 && packet[5] === 1).length;
    return packets;
  };
  t.after(() => { ClientHelloRecords.prototype.send = send; });
  const agent = createJamendoAgent('127.0.0.1');
  t.after(() => agent.destroy());
  const { body } = await readRequest(agent, server, {
    ca: cert, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ecdhCurve: 'X25519:P-256',
  });
  assert.equal(clientHellos, 2, 'the initial X25519 key share forces a P-256 retry');
  assert.deepEqual(body, expected);
});

test('certificate chain errors remain errors even if request options try to disable verification', async t => {
  const { server } = await secureServer(t);
  const agent = createJamendoAgent('127.0.0.1');
  t.after(() => agent.destroy());
  await assert.rejects(readRequest(agent, server, { rejectUnauthorized: false }), error =>
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
});

test('trusted test certificate still rejects a different hostname', async t => {
  const { server, cert } = await secureServer(t);
  const agent = createJamendoAgent('127.0.0.1');
  t.after(() => agent.destroy());
  await assert.rejects(readRequest(agent, server, { ca: cert, servername: 'unrelated.example' }),
    error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('cancelling a response body closes the encrypted connection and upstream stream', async t => {
  const { server, cert } = await secureServer(t);
  let observeClose;
  const remote = new Promise(resolve => { observeClose = resolve; });
  server.on('request', (_req, res) => {
    const closed = once(res, 'close');
    observeClose({ closed });
    res.write('first audio bytes');
  });
  const agent = createJamendoAgent('127.0.0.1');
  t.after(() => agent.destroy());
  await new Promise((resolve, reject) => {
    const req = https.get({ hostname: HOST, port: server.address().port, agent, ca: cert }, res => {
      res.once('error', () => {});
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.once('error', reject);
  });
  const { closed } = await remote;
  let timer;
  try {
    await Promise.race([closed, new Promise((_r, reject) => {
      timer = setTimeout(() => reject(new Error('upstream audio stream remained open')), 1000);
    })]);
  } finally { clearTimeout(timer); }
});

test('caller cancellation during the TLS handshake closes the raw connection', async t => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connected = once(server, 'connection');
  const agent = createJamendoAgent('127.0.0.1', { connectTimeoutMs: 5000 });
  t.after(() => agent.destroy());
  const controller = new AbortController();
  const pending = readRequest(agent, server, { signal: controller.signal });
  const [socket] = await connected;
  const closed = once(socket, 'close');
  t.after(() => socket.destroy());
  t.after(() => server.close());
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  await Promise.race([closed, new Promise((_r, reject) => {
    const timer = setTimeout(() => reject(new Error('cancel left raw connection open')), 1000); timer.unref();
  })]);
});

test('handshake deadline closes an unresponsive endpoint', async t => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connected = once(server, 'connection');
  const agent = createJamendoAgent('127.0.0.1', { connectTimeoutMs: 100 });
  t.after(() => agent.destroy());
  const pending = readRequest(agent, server);
  const [socket] = await connected;
  socket.resume();
  t.after(() => socket.destroy());
  t.after(() => server.close());
  await assert.rejects(pending, /timed out/i);
});
