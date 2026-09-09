'use strict';

// Sample catalog positions, not a popularity chart or a bundled track list.
function createDiscovery({request, random = Math.random}) {
  let total = 0;
  let countedAt = 0;
  let countRequest;
  async function count() {
    if (total && Date.now() - countedAt < 6 * 3600000) return total;
    if (!countRequest) countRequest = (async () => {
      for (let attempt=0;attempt<3;attempt++) {
        try {
          const result=await request({limit:'1',offset:'0',fullcount:'true'});
          const value=Number(result.headers && result.headers.results_fullcount);
          if (Number.isSafeInteger(value) && value>0) {
            total=value;
            countedAt=Date.now();
            return total;
          }
        } catch (_) { /* A failed count must never narrow discovery to a chart. */ }
        if(attempt<2) await new Promise(resolve=>setTimeout(resolve,500));
      }
      throw new Error('Catalog size unavailable');
    })().finally(() => { countRequest = null; });
    return countRequest;
  }
  return {
    async sample(size, excluded = new Set()) {
      const length = await count();
      const tracks = new Map();
      // Independent positions avoid drawing one album's adjacent tracks.
      const positions = new Set();
      for (let attempt = 0; attempt < 3 && tracks.size < size; attempt++) {
        const offsets = [];
        for (let i = 0; i < size - tracks.size; i++) {
          let offset = Math.floor(random() * length);
          for (let n = 0; n < 10 && positions.has(offset); n++) offset = Math.floor(random() * length);
          if (!positions.has(offset)) { positions.add(offset); offsets.push(offset); }
        }
        if (!offsets.length) break;
        const results = await Promise.allSettled(offsets.map(offset => request({limit:'1',offset:String(offset)})));
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const track of result.value.results || []) {
            if (track.id && track.audio && !excluded.has(String(track.id))) tracks.set(String(track.id),track);
          }
        }
      }
      if (!tracks.size) throw new Error('Random discovery temporarily unavailable');
      return [...tracks.values()].slice(0,size);
    },
  };
}
module.exports = {createDiscovery};
