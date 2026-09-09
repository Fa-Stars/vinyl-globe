'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {selectLocation, lookupJamendoCountry} = require('../web/jamendo-country');
const {startBackend} = require('../test-support/backend.cjs');

test('Jamendo country lookup resolves exact artist identity before requesting locations', async () => {
  const calls = [];
  const result = await lookupJamendoCountry('Local Band', null, {clientId: 'test', countries: {CH:'瑞士'}, fetchJson: async url => {
    const u = new URL(url); calls.push(u);
    return {headers:{status:'success'}, results:[{id:'123', name:'Local Band', locations:[{country:'CHE'}]}]};
  }});
  assert.equal(result.code, 'CH');
  assert.equal(calls[0].pathname, '/v3.0/artists/');
  assert.equal(calls[1].searchParams.get('id'), '123');
  assert.equal(result.sourceUrl, 'https://www.jamendo.com/artist/123');
});

test('Jamendo rejects namesakes, conflicting regions, and unmappable countries', () => {
  const artist = {id:'1', name:'Band', locations:[{country:'USA'}]};
  assert.equal(selectLocation([artist], 'Band', '2', {US:'美国'}), null);
  assert.equal(selectLocation([artist, {...artist,id:'2'}], 'Band', null, {US:'美国'}), null);
  assert.equal(selectLocation([{...artist,locations:[{country:'USA'},{country:'FRA'}]}], 'Band', '1', {US:'美国',FR:'法国'}), null);
  assert.equal(selectLocation([{...artist,locations:[{country:'XXX'}]}], 'Band', '1', {US:'美国'}), null);
});

test('temporary location failure remains retryable', async () => {
  const result = await lookupJamendoCountry('Band', '1', {clientId:'test', countries:{US:'美国'}, fetchJson:async()=>{throw new Error('timeout');}});
  assert.equal(result.definitive, false);
});

test('migrates historical Antilles only when the declared locality identifies Sint Maarten', () => {
  const artist = {id:'368292',name:'Lollita',locations:[{country:'ANT',city:'sint maarten'}]};
  assert.equal(selectLocation([artist],'Lollita','368292',{SX:'荷属圣马丁'}).code,'SX');
  artist.locations[0].city = '';
  assert.equal(selectLocation([artist],'Lollita','368292',{SX:'荷属圣马丁'}),null);
});

test('reviewed artist evidence overrides old negative caches but does not match unrelated namesakes', async t => {
  const verified = require('../web/verified-artist-countries.json').JekK;
  const backend = await startBackend(t, {pool:[{id:verified.trackIds[0], artist:'JekK', title:'Song',streamUrl:'http://127.0.0.1:1/audio'}], setup(root) {
    fs.writeFileSync(path.join(root,'artist-countries.json'), JSON.stringify({JekK:{code:null,source:'none',resolverVersion:8,ts:Date.now()}}));
  }});
  const rec = await (await backend.request('/api/country?id=' + verified.trackIds[0])).json();
  assert.equal(rec.countrycode,'FR');
  assert.equal(rec.source,'verified');
  assert.equal(rec.sourceUrl,verified.sourceUrl);
});

test('an unrelated song with a reviewed artist name does not inherit reviewed evidence', async t => {
  const verified = require('../web/verified-artist-countries.json').JekK;
  const backend = await startBackend(t, {pool:[
    {id:'unrelated',artist:'JekK',title:'Other',streamUrl:'http://127.0.0.1:1/audio'},
    {id:verified.trackIds[0],artist:'JekK',title:'Verified',streamUrl:'http://127.0.0.1:1/audio'},
  ], upstream(_req,res){res.end(JSON.stringify({headers:{status:'success'},results:[]}));}});
  const rec = await (await backend.request('/api/country?id=unrelated')).json();
  assert.equal(rec.countrycode,'');
});
