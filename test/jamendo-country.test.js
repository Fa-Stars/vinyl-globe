'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {selectLocation, lookupJamendoCountry} = require('../web/jamendo-country');
const {startBackend} = require('../test-support/backend.cjs');

const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/3.0/';

function liveTrack(id, extra = {}) {
  return {
    id: String(id),
    name: 'Song ' + id,
    artist_id: 'artist-' + id,
    artist_name: 'Artist ' + id,
    audio: 'http://127.0.0.1:1/audio',
    license_ccurl: LICENSE,
    ...extra,
  };
}

function replyJamendo(res, results) {
  res.end(JSON.stringify({headers:{status:'success'},results}));
}

function liveTracks(req, res, {maxId, tracks}) {
  const u = new URL(req.url, 'http://localhost');
  const route = u.searchParams.get('path');
  if (route === '/v3.0/tracks/') {
    if (u.searchParams.has('order')) return replyJamendo(res, [{id:String(maxId)}]);
    const ids = (u.searchParams.get('id') || '').split('+').filter(Boolean);
    return replyJamendo(res, ids.map(id => tracks[String(id)]).filter(Boolean));
  }
  if (route === '/v3.0/artists/locations/') return replyJamendo(res, []);
  res.writeHead(404);
  res.end();
}

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
  const backend = await startBackend(t, {catalogMaxId:1, upstream(req, res) {
    return liveTracks(req, res, {maxId:1, tracks:{1:liveTrack(1, {
      artist_id:verified.artistId,
      artist_name:'JekK',
      name:'Song',
    })}});
  }, setup(root) {
    fs.writeFileSync(path.join(root,'artist-countries.json'), JSON.stringify({JekK:{code:null,source:'none',resolverVersion:8,ts:Date.now()}}));
  }});
  await backend.waitForOutput(/Jamendo pool: 1 new random tracks/);
  const song = await (await backend.request('/api/song')).json();
  assert.equal(song.id, '1');
  assert.equal(song.artistId, verified.artistId);
  assert.deepEqual(song.license, {name:'CC BY-NC-SA 3.0',url:LICENSE});
  const rec = await (await backend.request('/api/country?id=1')).json();
  assert.equal(rec.countrycode,'FR');
  assert.equal(rec.source,'verified');
  assert.equal(rec.sourceUrl,verified.sourceUrl);
});

test('an unrelated song with a reviewed artist name does not inherit reviewed evidence', async t => {
  const verified = require('../web/verified-artist-countries.json').JekK;
  const backend = await startBackend(t, {catalogMaxId:2, upstream(req, res) {
    return liveTracks(req, res, {maxId:2, tracks:{
      1:liveTrack(1, {artist_id:'unrelated-artist',artist_name:'JekK',name:'Other'}),
      2:liveTrack(2, {artist_id:verified.artistId,artist_name:'JekK',name:'Verified'}),
    }});
  }});
  await backend.waitForOutput(/Jamendo pool: 2 new random tracks/);
  const reviewed = await (await backend.request('/api/country?id=2')).json();
  assert.equal(reviewed.countrycode,'FR');
  assert.equal(reviewed.source,'verified');
  assert.equal(reviewed.sourceUrl,verified.sourceUrl);
  const rec = await (await backend.request('/api/country?id=1')).json();
  assert.equal(rec.countrycode,'');
});
