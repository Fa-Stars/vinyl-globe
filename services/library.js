'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { fault } = require('./protocol');

function openLibrary(directory, { maxBytes, maxTracks }) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'library.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS tracks (id TEXT PRIMARY KEY, meta TEXT NOT NULL, hash TEXT NOT NULL, audio BLOB NOT NULL, cover BLOB NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, added INTEGER NOT NULL)');
  const list = db.prepare("SELECT id, added, json_extract(meta,'$.revision') AS revision FROM tracks WHERE expires > ? ORDER BY added");
  const pending = db.prepare(`SELECT id, json_extract(meta,'$.artist') AS artist,
    json_extract(meta,'$.artistId') AS artistId, json_extract(meta,'$.revision') AS revision
    FROM tracks WHERE expires > ? AND json_extract(meta,'$.provider') = 'jamendo'
    AND json_extract(meta,'$.countrycode') = '' AND json_extract(meta,'$.countryChecked') <= ?
    ORDER BY json_extract(meta,'$.countryChecked') LIMIT 1`);
  const updateLocation = db.prepare(`UPDATE tracks SET meta=json_set(meta,'$.countrycode',?,
    '$.country',?,'$.countryChecked',?) WHERE id=? AND json_extract(meta,'$.revision')=?`);
  const find = db.prepare('SELECT meta, hash, length(audio) AS size, length(cover) AS coverSize FROM tracks WHERE id = ? AND expires > ?');
  const read = Object.fromEntries(['audio','cover'].map(field => [field,
    db.prepare('SELECT substr(' + field + ', ?, ?) AS chunk FROM tracks WHERE id = ? AND expires > ?')]));
  const totals = db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM tracks');
  const remember = db.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?)');
  const remove = db.prepare('DELETE FROM tracks WHERE id = ?');
  const expired = db.prepare('DELETE FROM tracks WHERE expires <= ?');
  const metadata = db.prepare('UPDATE tracks SET meta=?,expires=?,added=? WHERE id=?');
  return {
    list: () => list.all(Date.now()),
    find: id => find.get(id, Date.now()),
    usage: () => totals.get(),
    pendingCountry: () => pending.get(Date.now(), Date.now() - 600000),
    updateCountry: (id, revision, code, country) => updateLocation.run(code, country, Date.now(), id, revision),
    read: (type, id, start, length) => read[type].get(start + 1, length, id, Date.now())?.chunk,
    expire: () => expired.run(Date.now()),
    remove: id => remove.run(id),
    put(track, audio, cover, hash, pinned, replace) {
      const bytes = audio.length + cover.length;
      if (bytes > maxBytes) throw fault(507, 'Track exceeds library budget');
      db.exec('BEGIN IMMEDIATE');
      try {
        expired.run(Date.now());
        const existing = find.get(track.id, Date.now());
        if (existing) {
          if (existing.hash !== hash) throw fault(409, 'Track ID already has different media');
          metadata.run(JSON.stringify(track), track.validUntil, Date.now(), track.id);
        } else {
          if (replace) {
            if (pinned.has(replace)) throw fault(409, 'Rotation candidate in use');
            remove.run(replace);
          }
          const usage = totals.get();
          if (usage.bytes + bytes > maxBytes || usage.count >= maxTracks) throw fault(507, 'Library capacity reserved by active playback');
          remember.run(track.id, JSON.stringify(track), hash, audio, cover, bytes, track.validUntil, Date.now());
        }
        db.exec('COMMIT');
        return !existing;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

module.exports = { openLibrary };
