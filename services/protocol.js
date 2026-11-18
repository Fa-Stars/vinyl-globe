'use strict';

const { createHash } = require('node:crypto');

const AUDIO_LIMIT = 16 * 1024 * 1024;
const COVER_LIMIT = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const audioTypes = new Set(['audio/mpeg', 'audio/wav']);
const coverTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function fault(status, message) {
  return Object.assign(new Error(message), { status });
}

function integer(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError('Invalid numeric setting');
  return n;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readLimited(stream, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) throw fault(413, 'Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function validTrack(track) {
  if (!track || typeof track.id !== 'string' || !ID.test(track.id) ||
      !['title','artist','grant'].every(k => typeof track[k] === 'string' && track[k].trim()) ||
      !audioTypes.has(track.audioType) || (track.coverType && !coverTypes.has(track.coverType)) ||
      !Number.isFinite(track.duration) || track.duration < 0 ||
      (track.countrycode && !/^[A-Z]{2}$/.test(track.countrycode)) ||
      !Number.isSafeInteger(track.validUntil) || track.validUntil <= Date.now()) {
    throw fault(400, 'Invalid or expired track metadata');
  }
}

module.exports = { AUDIO_LIMIT, COVER_LIMIT, ID, audioTypes, coverTypes, digest, fault, integer, readLimited, validTrack };
