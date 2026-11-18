'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const test = require('node:test');
const { createPlayer } = require('../test-support/player.cjs');

function readPixels(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 3 + 1);
    assert.equal(raw[start], 0, 'PNG rows use the supported unfiltered encoding');
    raw.copy(pixels, y * width * 3, start + 1, start + 1 + width * 3);
  }
  return { width, height, pixels };
}

test('globe preview CLI exports the current app frames for a large and small country', async t => {
  const temp = fs.realpathSync(os.tmpdir());
  const outDir = fs.mkdtempSync(path.join(temp, 'vinyl-globe-preview-'));
  t.after(() => {
    const relative = path.relative(temp, fs.realpathSync(outDir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  const repo = path.resolve(__dirname, '..');
  execFileSync(process.execPath, [path.join(repo, 'web/scripts/render-globe.js'),
    'FR', 'MT', '--out-dir', outDir, '--scale', '1'], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['globe-FR.png', 'globe-MT.png']);

  const mapData = JSON.parse(fs.readFileSync(path.join(repo, 'web/public/map.json'), 'utf8'));
  const capitals = JSON.parse(fs.readFileSync(path.join(repo, 'web/public/capitals.json'), 'utf8'));
  const player = await createPlayer({
    mapData,
    capitalsResponse: response => response(capitals),
    infoResponse: response => response({ mode: 'setup-required', configured: false }),
  });
  assert.equal(player.songsRequested, 0, 'preview rendering should not prepare songs');
  for (const code of ['FR', 'MT']) {
    assert.equal(player.focusCountry(code).code, code);
    const actual = readPixels(path.join(outDir, 'globe-' + code + '.png'));
    const expected = player.lastFrame;
    assert.equal(actual.width, expected.width);
    assert.equal(actual.height, expected.height);
    const rgb = Buffer.alloc(expected.width * expected.height * 3);
    for (let source = 0, target = 0; source < expected.data.length; source += 4) {
      rgb[target++] = expected.data[source];
      rgb[target++] = expected.data[source + 1];
      rgb[target++] = expected.data[source + 2];
    }
    assert.deepEqual(actual.pixels, rgb, 'PNG must contain app.js pixels, not an independent renderer');
  }
});
