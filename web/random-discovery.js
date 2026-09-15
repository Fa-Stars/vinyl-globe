'use strict';

const BOUNDS_TTL = 6 * 3600000;
const MAX_STALE = 30 * 86400000;

// Uniformly draw exact IDs across the live catalog's numeric range. Missing IDs
// are rejected, never replaced with a nearby song (which would favor sparse areas).
function createDiscovery({ request, random = Math.random, now = Date.now, cachedBounds, saveBounds = () => {} }) {
  let bounds = cachedBounds;
  let boundsRequest = null;
  function validBounds(value) {
    return value && Number.isSafeInteger(value.maxId) && value.maxId > 0 &&
      Number.isFinite(value.checkedAt) && value.checkedAt <= now() && now() - value.checkedAt < MAX_STALE;
  }
  if (!validBounds(bounds)) bounds = null;

  async function refreshBounds() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await request({ limit: '1', order: 'id_desc' });
        const maxId = Number(result.results?.[0]?.id);
        if (Number.isSafeInteger(maxId) && maxId > 0) {
          bounds = { maxId, checkedAt: now() };
          try { saveBounds(bounds); } catch { /* Cache failure must not block discovery. */ }
          return bounds;
        }
      } catch { /* Never fall back to a chart or a hard-coded ID range. */ }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Catalog ID range unavailable');
  }

  async function range() {
    if (validBounds(bounds) && now() - bounds.checkedAt < BOUNDS_TTL) return bounds.maxId;
    if (!boundsRequest) boundsRequest = refreshBounds().finally(() => { boundsRequest = null; });
    if (validBounds(bounds)) {
      boundsRequest.catch(() => {});
      return bounds.maxId; // Refresh only the numeric boundary in the background.
    }
    return (await boundsRequest).maxId;
  }

  return {
    async sample(size, excluded = new Set(), onTracks = () => {}) {
      if (!Number.isSafeInteger(size) || size < 1 || size > 200) throw new RangeError('Invalid sample size');
      const maxId = await range();
      const tracks = new Map();
      const attempted = new Set();
      for (let attempt = 0; attempt < 4 && tracks.size < size; attempt++) {
        // Oversample holes in the ID range, but keep every request below API limits.
        const count = Math.min(200, Math.max(16, (size - tracks.size) * 4), maxId);
        const ids = new Set();
        for (let draw = 0; draw < count * 20 && ids.size < count; draw++) {
          const id = String(1 + Math.floor(random() * maxId));
          if (!attempted.has(id) && !excluded.has(id)) ids.add(id);
        }
        if (!ids.size) break;
        // Preserve the draw order rather than the API's popularity/ID sort order.
        let result;
        try { result = await request({ id: [...ids].join('+'), limit: String(ids.size) }); }
        catch { continue; }
        for (const id of ids) attempted.add(id);
        const found = new Map((result.results || []).map(track => [String(track.id), track]));
        const fresh = [];
        for (const id of ids) {
          const track = found.get(id);
          if (track?.audio && !tracks.has(id) && tracks.size < size) {
            tracks.set(id, track);
            fresh.push(track);
          }
        }
        if (fresh.length) onTracks(fresh);
      }
      if (!tracks.size) throw new Error('Random discovery temporarily unavailable');
      return [...tracks.values()];
    },
  };
}

module.exports = { createDiscovery };
