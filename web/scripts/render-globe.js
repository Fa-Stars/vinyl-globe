'use strict';

// Render the actual app.js Canvas implementation, with no duplicate palette or
// projection code and no browser, credentials, network, or third-party modules.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createPlayer } = require('../../test-support/player.cjs');

const WEB_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CODES = ['DE', 'US', 'RU', 'NL', 'MT', 'SG', 'JP', 'BR'];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'ascii');
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(frame, scale) {
  const width = frame.width * scale;
  const height = frame.height * scale;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (Math.floor(y / scale) * frame.width + Math.floor(x / scale)) * 4;
      const target = y * rowSize + 1 + x * 3;
      raw[target] = frame.data[source];
      raw[target + 1] = frame.data[source + 1];
      raw[target + 2] = frame.data[source + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // RGB, PNG filter 0 on each row.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function renderGlobePreviews({ codes = DEFAULT_CODES, outDir = path.join(WEB_ROOT, '../data'), scale = 3 } = {}) {
  if (!Number.isInteger(scale) || scale < 1 || scale > 8) throw new RangeError('Scale must be an integer from 1 to 8');
  if (!Array.isArray(codes) || !codes.length || codes.some(code => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) {
    throw new RangeError('Expected two-letter uppercase country codes');
  }
  const mapData = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'public/map.json'), 'utf8'));
  const capitals = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'public/capitals.json'), 'utf8'));
  const player = await createPlayer({
    mapData,
    capitalsResponse: response => response(capitals),
    infoResponse: response => response({ mode: 'setup-required', configured: false }),
  });
  const previews = [];
  for (const code of [...new Set(codes)]) {
    const info = player.focusCountry(code);
    if (!info) continue;
    const frame = player.lastFrame;
    const file = path.resolve(outDir, 'globe-' + code + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(frame, scale));
    previews.push({ ...info, file, width: frame.width * scale, height: frame.height * scale });
  }
  return previews;
}

function parseArgs(args) {
  const options = { codes: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--out-dir') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--out-dir needs a directory');
      options.outDir = path.resolve(value);
    } else if (arg === '--scale') {
      options.scale = Number(args[++index]);
    } else if (/^[a-z]{2}$/i.test(arg)) {
      options.codes.push(arg.toUpperCase());
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!options.codes.length) delete options.codes;
  return options;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: node web/scripts/render-globe.js [FR MT ...] [--out-dir DIRECTORY] [--scale 1..8]');
      console.log('Defaults: data/globe-XX.png, scale 3. Renders the current app.js without network access.');
      return;
    }
    const options = parseArgs(args);
    const previews = await renderGlobePreviews(options);
    for (const preview of previews) {
      console.log(preview.code + ': ' + preview.width + 'x' + preview.height +
        ', zoom=' + preview.zoom.toFixed(2) + ', ' + preview.file);
    }
    if (!previews.length) throw new Error('No requested country could be located');
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { renderGlobePreviews };
