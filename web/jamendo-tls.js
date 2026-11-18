'use strict';

const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { Duplex } = require('node:stream');

const HRR_RANDOM = Buffer.from('cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c', 'hex');
const MAX_RECORD = 18432;
const MAX_HELLO = 256 * 1024;
const MAX_PENDING = MAX_HELLO + MAX_RECORD + 5;

function record(payload, version) {
  const header = Buffer.from([22, version[0], version[1], 0, 0]);
  header.writeUInt16BE(payload.length, 3);
  return Buffer.concat([header, payload]);
}

// Locate a boundary within SNI without changing any handshake payload byte.
function sniCut(hello, expectedHostname) {
  const end = 4 + hello.readUIntBE(1, 3);
  let offset = 38;
  function need(length) { if (offset + length > end) throw new Error('Truncated ClientHello'); }
  need(1); const sessionLength = hello[offset++]; need(sessionLength); offset += sessionLength;
  need(2); const cipherLength = hello.readUInt16BE(offset); offset += 2; need(cipherLength); offset += cipherLength;
  need(1); const compressionLength = hello[offset++]; need(compressionLength); offset += compressionLength;
  need(2); const extensionLength = hello.readUInt16BE(offset); offset += 2;
  if (offset + extensionLength !== end) throw new Error('Invalid ClientHello extensions');
  while (offset < end) {
    need(4); const type = hello.readUInt16BE(offset); const length = hello.readUInt16BE(offset + 2); offset += 4;
    need(length); const extensionEnd = offset + length;
    if (type === 0) {
      need(2); const listLength = hello.readUInt16BE(offset); offset += 2;
      if (offset + listLength !== extensionEnd) throw new Error('Invalid SNI list');
      while (offset < extensionEnd) {
        if (offset + 3 > extensionEnd) throw new Error('Invalid SNI entry');
        const nameType = hello[offset++]; const nameLength = hello.readUInt16BE(offset); offset += 2;
        if (offset + nameLength > extensionEnd) throw new Error('Invalid SNI name');
        if (nameType === 0) {
          const name = hello.toString('ascii', offset, offset + nameLength);
          if (name !== expectedHostname || name.endsWith('.') || nameLength < 2) throw new Error('Unexpected SNI hostname');
          return offset + Math.floor(nameLength / 2);
        }
        offset += nameLength;
      }
    }
    offset = extensionEnd;
  }
  throw new Error('ClientHello has no SNI');
}

class ClientHelloRecords {
  constructor(hostname) {
    this.hostname = hostname;
    this.outbound = Buffer.alloc(0);
    this.inbound = Buffer.alloc(0);
    this.serverHandshake = Buffer.alloc(0);
    this.helloRecords = [];
    this.helloBytes = 0;
    this.helloPayload = Buffer.alloc(0);
    this.expectHello = true;
    this.serverHelloSeen = false;
    this.secure = false;
  }
  markSecure() {
    this.assertFlushed();
    this.secure = true;
    this.inbound = Buffer.alloc(0);
    this.serverHandshake = Buffer.alloc(0);
  }
  receive(chunk) {
    if (this.secure || this.serverHelloSeen) return;
    if (this.inbound.length + chunk.length > MAX_PENDING) throw new Error('Inbound TLS buffer exceeds limit');
    this.inbound = Buffer.concat([this.inbound, chunk]);
    while (this.inbound.length >= 5) {
      const length = this.inbound.readUInt16BE(3);
      if (length > MAX_RECORD) throw new Error('Inbound TLS record exceeds limit');
      if (this.inbound.length < length + 5) return;
      const packet = this.inbound.subarray(0, length + 5);
      this.inbound = this.inbound.subarray(length + 5);
      if (packet[0] !== 22) continue;
      if (this.serverHandshake.length + length > MAX_HELLO) throw new Error('Inbound handshake exceeds limit');
      this.serverHandshake = Buffer.concat([this.serverHandshake, packet.subarray(5)]);
      while (this.serverHandshake.length >= 4) {
        const messageLength = this.serverHandshake.readUIntBE(1, 3) + 4;
        if (messageLength > MAX_HELLO) throw new Error('Inbound handshake length exceeds limit');
        if (this.serverHandshake.length < messageLength) break;
        const message = this.serverHandshake.subarray(0, messageLength);
        this.serverHandshake = this.serverHandshake.subarray(messageLength);
        if (message[0] !== 2) continue;
        if (message.length >= 38 && message.subarray(6, 38).equals(HRR_RANDOM)) {
          this.expectHello = true;
        } else {
          // TLS 1.2 encrypted Finished still has record type 22. Once a real
          // ServerHello arrives, leave all subsequent validation to OpenSSL.
          this.serverHelloSeen = true;
          this.inbound = Buffer.alloc(0);
          this.serverHandshake = Buffer.alloc(0);
          return;
        }
      }
    }
  }
  send(chunk) {
    if (this.secure) return [chunk];
    if (this.outbound.length + chunk.length > MAX_PENDING) throw new Error('Outbound TLS buffer exceeds limit');
    this.outbound = Buffer.concat([this.outbound, chunk]);
    const ready = [];
    while (this.outbound.length >= 5) {
      const length = this.outbound.readUInt16BE(3);
      if (length > MAX_RECORD) throw new Error('Outbound TLS record exceeds limit');
      if (this.outbound.length < length + 5) break;
      const packet = this.outbound.subarray(0, length + 5);
      this.outbound = this.outbound.subarray(length + 5);
      if (!this.expectHello) { ready.push(packet); continue; }
      if (packet[0] !== 22) {
        if (this.helloRecords.length) throw new Error('Non-handshake record interrupts ClientHello');
        ready.push(packet); continue;
      }
      if (this.helloPayload.length + length > MAX_HELLO || this.helloBytes + packet.length > MAX_PENDING) {
        throw new Error('ClientHello exceeds limit');
      }
      this.helloRecords.push(packet);
      this.helloBytes += packet.length;
      this.helloPayload = Buffer.concat([this.helloPayload, packet.subarray(5)]);
      if (this.helloPayload.length < 4) continue;
      if (this.helloPayload[0] !== 1) throw new Error('Expected ClientHello handshake');
      const messageLength = 4 + this.helloPayload.readUIntBE(1, 3);
      if (messageLength > MAX_HELLO) throw new Error('ClientHello length exceeds limit');
      if (this.helloPayload.length < messageLength) continue;
      const cut = sniCut(this.helloPayload, this.hostname);
      let consumed = 0;
      let divided = false;
      for (const original of this.helloRecords) {
        const payload = original.subarray(5);
        if (!divided && cut > consumed && cut < consumed + payload.length) {
          const at = cut - consumed;
          ready.push(record(payload.subarray(0, at), original.subarray(1, 3)));
          ready.push(record(payload.subarray(at), original.subarray(1, 3)));
          divided = true;
        } else {
          ready.push(original);
          if (cut === consumed || cut === consumed + payload.length) divided = true;
        }
        consumed += payload.length;
      }
      if (!divided) throw new Error('Could not divide ClientHello record');
      this.helloRecords = [];
      this.helloBytes = 0;
      this.helloPayload = Buffer.alloc(0);
      this.expectHello = false;
    }
    return ready;
  }
  assertFlushed() {
    if (this.outbound.length || this.helloRecords.length) throw new Error('TLS output ended with incomplete ClientHello');
  }
}

class RecordTransport extends Duplex {
  constructor(raw, hostname) {
    super({ readableHighWaterMark: 64 * 1024, writableHighWaterMark: 64 * 1024 });
    this.raw = raw;
    this.records = new ClientHelloRecords(hostname);
    raw.on('data', chunk => {
      try {
        // OpenSSL may synchronously send another ClientHello after an HRR.
        this.records.receive(chunk);
        if (!this.push(chunk)) raw.pause();
      } catch (error) { this.destroy(error); }
    });
    raw.once('end', () => this.push(null));
    raw.once('error', error => this.destroy(error));
    raw.once('close', () => {
      // A normal FIN can precede TLS consuming the final queued ciphertext.
      // push(null) preserves that data; destroy here would discard it.
      if (!raw.readableEnded && !this.destroyed) this.destroy();
    });
  }
  _read() { this.raw.resume(); }
  _write(chunk, encoding, callback) {
    let packets;
    try { packets = this.records.send(chunk); } catch (error) { callback(error); return; }
    // Acknowledge bounded partial records so OpenSSL can write their remainder.
    if (!packets.length) { callback(); return; }
    this.raw.cork();
    for (let index = 0; index < packets.length; index++) {
      this.raw.write(packets[index], index === packets.length - 1 ? callback : undefined);
    }
    this.raw.uncork();
  }
  _final(callback) {
    try { this.records.assertFlushed(); } catch (error) { callback(error); return; }
    this.raw.end(callback);
  }
  _destroy(error, callback) { this.raw.destroy(); callback(error); }
}

function createJamendoAgent(address, { connectTimeoutMs = 8000 } = {}) {
  const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
  agent.createConnection = options => {
    const hostname = options.servername || options.hostname || options.host;
    if (typeof hostname !== 'string' || hostname.endsWith('.') || net.isIP(hostname)) {
      throw new Error('Expected standard DNS SNI');
    }
    // TLS owns the bidirectional shutdown. A peer's TCP FIN must not disable
    // the pending close_notify write while buffered ciphertext is draining.
    const raw = net.connect({ host: address, port: options.port || 443, allowHalfOpen: true });
    const wire = new RecordTransport(raw, hostname);
    let secure;
    try {
      secure = tls.connect({
        ...options, socket: wire, servername: hostname, rejectUnauthorized: true,
        checkServerIdentity: tls.checkServerIdentity, ALPNProtocols: ['http/1.1'],
      });
    } catch (error) { wire.destroy(); throw error; }
    const timer = setTimeout(() => {
      const error = new Error('TLS connection timed out');
      error.code = 'ETIMEDOUT';
      secure.destroy(error);
    }, connectTimeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      try { wire.records.markSecure(); } catch (error) { secure.destroy(error); }
    });
    secure.once('close', () => { clearTimeout(timer); wire.destroy(); });
    return secure;
  };
  return agent;
}

module.exports = { createJamendoAgent, ClientHelloRecords };
