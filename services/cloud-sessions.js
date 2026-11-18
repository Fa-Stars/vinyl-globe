'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const { fault } = require('./protocol');

function createSessions(library, maxSessions = 32) {
  const sessions = new Map();
  const target = 5;
  const lifetime = 120000;

  function expire() {
    for (const [token, s] of sessions) if (Date.now() - s.seen >= lifetime) sessions.delete(token);
  }

  function get(token) {
    expire();
    const s = sessions.get(token);
    if (!s) throw fault(401, 'SESSION_EXPIRED');
    s.seen = Date.now();
    return s;
  }

  function fill(s) {
    const ids = library.list().map(item => item.id);
    const available = new Set(ids);
    s.queue = s.queue.filter(id => available.has(id));
    const choices = ids.filter(id => id !== s.current && !s.queue.includes(id));
    while (s.queue.length < target && choices.length) {
      const fresh = choices.filter(id => !s.history.includes(id));
      const pool = fresh.length ? fresh : choices;
      const id = pool[randomInt(pool.length)];
      s.queue.push(id);
      choices.splice(choices.indexOf(id), 1);
    }
    if (!s.queue.length && available.has(s.current)) s.queue.push(s.current);
    return s.queue;
  }

  return {
    get, fill, expire, target,
    open() {
      expire();
      if (sessions.size >= maxSessions) throw fault(503, 'SESSION_CAPACITY');
      const token = randomUUID();
      const s = { seen: Date.now(), sequence: 0, queue: [], current: '', history: [] };
      fill(s);
      sessions.set(token, s);
      return { token, target, heartbeatMs: 20000, expiresInMs: lifetime };
    },
    close: token => sessions.delete(token),
    count() { expire(); return sessions.size; },
    pinned() {
      expire();
      return new Set([...sessions.values()].flatMap(s => [s.current,...s.queue]));
    },
    take(s, sequence) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw fault(400, 'INVALID_SEQUENCE');
      if (sequence < s.sequence) throw fault(409, 'STALE_SEQUENCE');
      if (sequence === s.sequence) {
        if (!library.find(s.current)) throw fault(410, 'TRACK_WITHDRAWN');
        return s.current;
      }
      const id = fill(s).shift();
      if (!id) throw fault(503, 'BUFFER_PREPARING');
      s.current = id;
      s.sequence = sequence;
      s.history.push(id);
      s.history = s.history.slice(-64);
      fill(s);
      return id;
    },
  };
}
module.exports = { createSessions };
