'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function tone(index) {
  const rate = 16000, samples = rate * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n++) bytes.writeInt16LE(Math.round(2400 * Math.sin(2 * Math.PI * (220 + index * 17) * n / rate)), 44 + n * 2);
  return bytes;
}

async function writeCatalog(dir, count = 12) {
  await fs.mkdir(dir, { recursive: true });
  const entries = [];
  for (let i = 0; i < count; i++) {
    const id = 'tone-' + i, file = id + '.wav';
    await fs.writeFile(path.join(dir, file), tone(i), { flag: 'wx' });
    entries.push({ id, provider: 'local', title: 'Tone ' + i, artist: 'World Vinyl test',
      duration: 2, countrycode: ['CN','GB','BR'][i % 3], file, audioType: 'audio/wav',
      grant: 'Project-generated test tone', validUntil: new Date(Date.now() + 86400000).toISOString() });
  }
  const manifest = path.join(dir, 'tracks.json');
  await fs.writeFile(manifest, JSON.stringify(entries), { flag: 'wx' });
  return manifest;
}
if (require.main === module) writeCatalog(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { writeCatalog, tone };
