'use strict';

// MPEG Layer III bit rates in kb/s, by header index.
const mpeg1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
const mpeg2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];

function frameLength(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff) return 0;
  const flags = bytes[offset + 1];
  if ((flags & 0xe6) !== 0xe2) return 0;
  const version = (flags >> 3) & 3;
  if (version === 1) return 0;
  const format = bytes[offset + 2];
  const bitrate = (version === 3 ? mpeg1 : mpeg2)[format >> 4];
  const baseRate = [44100,48000,32000][(format >> 2) & 3];
  if (!bitrate || !baseRate) return 0;
  const sampleRate = baseRate / (version === 3 ? 1 : version === 2 ? 2 : 4);
  return Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((format >> 1) & 1);
}

function hasMp3Frames(bytes) {
  let offset = 0;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (bytes.length < 10 || ![2,3,4].includes(bytes[3])) return false;
    const size = bytes.subarray(6, 10);
    if (size.some(b => b >= 128)) return false;
    offset = 10 + size.reduce((n, b) => n * 128 + b, 0);
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10;
  }
  const first = frameLength(bytes, offset);
  const second = first && frameLength(bytes, offset + first);
  return second > 0 && offset + first + second <= bytes.length;
}

module.exports = { hasMp3Frames };
