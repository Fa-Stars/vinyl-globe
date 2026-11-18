'use strict';

// Only artwork supplied by the music source is fetched, never a client URL.
function allowedArtwork(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password &&
      /^(?:api|usercontent|images|www)\.jamendo\.com$/.test(u.hostname);
  } catch { return false; }
}

function createArtworkCache({ fetch, now = Date.now, maxBytes = 16 * 1024 * 1024,
  maxItemBytes = 1024 * 1024, maxEntries = 16 } = {}) {
  const entries = new Map();
  const pending = new Map();
  let bytes = 0;
  const remove = key => { const e = entries.get(key); if (e) bytes -= e.body?.length || 0; entries.delete(key); };
  function prune() {
    for (const [key, e] of entries) if (e.expires <= now()) remove(key);
    while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
  }
  async function load(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let result = null;
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!allowedArtwork(url)) break;
        const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'image/*' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          url = new URL(response.headers.get('location'), url).href;
          continue;
        }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!response.ok || !response.body || !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type) ||
            Number(response.headers.get('content-length')) > maxItemBytes) {
          await response.body?.cancel(); break;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maxItemBytes) throw new Error('artwork limit');
            chunks.push(Buffer.from(part.value));
          }
          if (size) result = { body: Buffer.concat(chunks), type };
        } finally { try { await reader.cancel(); } catch { /* already closed */ } reader.releaseLock(); }
        break;
      }
    } catch { /* A local sleeve is used when artwork is unavailable. */ }
    finally { clearTimeout(timer); }
    return result;
  }
  async function get(url) {
    if (!allowedArtwork(url)) return null;
    prune();
    if (entries.has(url)) return entries.get(url).value;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 4) return null;
    const task = load(url).then(value => {
      entries.set(url, { value, body: value?.body, expires: now() + (value ? 15 * 60000 : 60000) });
      bytes += value?.body.length || 0;
      prune();
      return value;
    }).finally(() => pending.delete(url));
    pending.set(url, task);
    return task;
  }
  return { get, prune, stats: () => ({ entries: entries.size, bytes, pending: pending.size, maxBytes }) };
}

module.exports = { createArtworkCache, allowedArtwork };
