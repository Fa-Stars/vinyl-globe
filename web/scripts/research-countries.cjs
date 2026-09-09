'use strict';
const fs = require('fs');
const path = require('path');
const { lookupJamendoCountry } = require('../jamendo-country');
const root = path.resolve(__dirname, '../..');
const poolPath = path.join(root, 'data/jamendo/pool.json');
const pool = JSON.parse(fs.readFileSync(fs.existsSync(poolPath) ? poolPath : path.join(root, 'data/research-catalog.json')));
const clientId = process.env.JAMENDO_CLIENT_ID || JSON.parse(fs.readFileSync(path.join(root, 'data/config.json'))).jamendoClientId;
const seedPath = path.join(root, 'web/jamendo-country-seed.json');
const output = fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath)) : {};
const names = [...new Set(pool.map(s => s.artist))].filter(name => !output[name]);
const display = new Intl.DisplayNames(['zh'], {type: 'region'});
const countries = new Proxy({}, {get: (_, code) => /^[A-Z]{2}$/.test(String(code)) ? display.of(code) : undefined});
let index = 0;
async function worker() {
  while (index < names.length) {
    const name = names[index++];
    const identity = pool.find(song => song.artist === name)?.artistId;
    const result = await lookupJamendoCountry(name, identity, {clientId, countries, fetchJson: async url => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const res = await fetch(url, {signal: AbortSignal.timeout(12000)});
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }});
    if (result.code) output[name] = {...result, country: countries[result.code], checkedAt: new Date().toISOString(), trackIds: pool.filter(s=>s.artist===name).map(s=>s.id)};
    fs.writeFileSync(seedPath, JSON.stringify(output, null, 2) + '\n');
    console.log(name + ': ' + (result.code || (result.definitive ? 'no location' : 'temporary failure')));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
worker().then(() => {
  fs.writeFileSync(path.join(root, 'web/jamendo-country-seed.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({artists: names.length, resolved: Object.keys(output).length, tracks: pool.filter(s => output[s.artist]).length}));
});
