'use strict';
// Build the pixelated world map used by the front-end globe.
// Rasterizes Natural Earth 110m admin-0 countries into a W x H grid where
// every cell holds the 2-letter ISO code of the country covering it (".." = sea).
// Output: public/map.json  (fetched by the browser)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GEO_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';
const GEO_FILE = path.join(ROOT, 'data', 'ne_110m_admin_0_countries.geojson');
const OUT = path.join(ROOT, 'public', 'map.json');

const W = 144; // cells per row  (2.5 deg per cell)
const H = 72;  // rows          (2.5 deg per cell)

// ISO 3166-1 alpha-3 -> alpha-2 (used when ISO_A2 is "-99" / missing)
const A3_TO_A2 = {
  AFG:'AF',ALB:'AL',DZA:'DZ',ASM:'AS',AND:'AD',AGO:'AO',AIA:'AI',ATA:'AQ',ATG:'AG',
  ARG:'AR',ARM:'AM',ABW:'AW',AUS:'AU',AUT:'AT',AZE:'AZ',BHS:'BS',BHR:'BH',BGD:'BD',
  BRB:'BB',BLR:'BY',BEL:'BE',BLZ:'BZ',BEN:'BJ',BMU:'BM',BTN:'BT',BOL:'BO',BIH:'BA',
  BWA:'BW',BRA:'BR',BRN:'BN',BGR:'BG',BFA:'BF',BDI:'BI',CPV:'CV',KHM:'KH',CMR:'CM',
  CAN:'CA',CYM:'KY',CAF:'CF',TCD:'TD',CHL:'CL',CHN:'CN',CXR:'CX',COL:'CO',COM:'KM',
  COG:'CG',COD:'CD',COK:'CK',CRI:'CR',CIV:'CI',HRV:'HR',CUB:'CU',CYP:'CY',CZE:'CZ',
  DNK:'DK',DJI:'DJ',DMA:'DM',DOM:'DO',ECU:'EC',EGY:'EG',SLV:'SV',GNQ:'GQ',ERI:'ER',
  EST:'EE',SWZ:'SZ',ETH:'ET',FLK:'FK',FRO:'FO',FJI:'FJ',FIN:'FI',FRA:'FR',PYF:'PF',
  GAB:'GA',GMB:'GM',GEO:'GE',DEU:'DE',GHA:'GH',GIB:'GI',GRC:'GR',GRL:'GL',GRD:'GD',
  GLP:'GP',GUM:'GU',GTM:'GT',GIN:'GN',GNB:'GW',GUY:'GY',HTI:'HT',VAT:'VA',HND:'HN',
  HKG:'HK',HUN:'HU',ISL:'IS',IND:'IN',IDN:'ID',IRN:'IR',IRQ:'IQ',IRL:'IE',ISR:'IL',
  ITA:'IT',JAM:'JM',JPN:'JP',JOR:'JO',KAZ:'KZ',KEN:'KE',KIR:'KI',PRK:'KP',KOR:'KR',
  KWT:'KW',KGZ:'KG',LAO:'LA',LVA:'LV',LBN:'LB',LSO:'LS',LBR:'LR',LBY:'LY',LIE:'LI',
  LTU:'LT',LUX:'LU',MAC:'MO',MDG:'MG',MWI:'MW',MYS:'MY',MDV:'MV',MLI:'ML',MLT:'MT',
  MHL:'MH',MTQ:'MQ',MRT:'MR',MUS:'MU',MYT:'YT',MEX:'MX',FSM:'FM',MDA:'MD',MCO:'MC',
  MNG:'MN',MSR:'MS',MAR:'MA',MOZ:'MZ',MMR:'MM',NAM:'NA',NRU:'NR',NPL:'NP',NLD:'NL',
  NCL:'NC',NZL:'NZ',NIC:'NI',NER:'NE',NGA:'NG',NIU:'NU',NFK:'NF',MKD:'MK',MNP:'MP',
  NOR:'NO',OMN:'OM',PAK:'PK',PLW:'PW',PAN:'PA',PNG:'PG',PRY:'PY',PER:'PE',PHL:'PH',
  PCN:'PN',POL:'PL',PRT:'PT',PRI:'PR',QAT:'QA',REU:'RE',ROU:'RO',RUS:'RU',RWA:'RW',
  SHN:'SH',KNA:'KN',LCA:'LC',SPM:'PM',VCT:'VC',WSM:'WS',SMR:'SM',STP:'ST',SAU:'SA',
  SEN:'SN',SRB:'RS',SYC:'SC',SLE:'SL',SGP:'SG',SVK:'SK',SVN:'SI',SLB:'SB',SOM:'SO',
  ZAF:'ZA',SSD:'SS',ESP:'ES',LKA:'LK',SDN:'SD',SUR:'SR',SJM:'SJ',SWE:'SE',CHE:'CH',
  SYR:'SY',TWN:'TW',TJK:'TJ',TZA:'TZ',THA:'TH',TLS:'TL',TGO:'TG',TKL:'TK',TON:'TO',
  TTO:'TT',TUN:'TN',TUR:'TR',TKM:'TM',TCA:'TC',TUV:'TV',UGA:'UG',UKR:'UA',ARE:'AE',
  GBR:'GB',USA:'US',URY:'UY',UZB:'UZ',VUT:'VU',VEN:'VE',VNM:'VN',VGB:'VG',VIR:'VI',
  WLF:'WF',ESH:'EH',YEM:'YE',ZMB:'ZM',ZWE:'ZW',UNK:'XK',KOS:'XK',
};

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function main() {
  if (!fs.existsSync(GEO_FILE)) {
    console.log('Downloading Natural Earth GeoJSON ...');
    const res = await fetch(GEO_URL, { headers: { 'User-Agent': 'vinyl-globe/1.0' } });
    if (!res.ok) throw new Error('download failed: ' + res.status + ' ' + GEO_URL);
    fs.writeFileSync(GEO_FILE, Buffer.from(await res.arrayBuffer()));
    console.log('saved', GEO_FILE, fs.statSync(GEO_FILE).size, 'bytes');
  } else {
    console.log('using cached', GEO_FILE);
  }

  const geojson = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8'));

  // --- prepare features ------------------------------------------------
  const feats = [];
  let skipped = 0;
  for (const f of geojson.features) {
    const p = f.properties;
    let code = String(p.ISO_A2 || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) code = A3_TO_A2[String(p.ISO_A3 || '').trim().toUpperCase()] || '';
    if (!code) code = A3_TO_A2[String(p.ADM0_A3 || '').trim().toUpperCase()] || '';
    if (!code) { skipped++; continue; } // no usable code (e.g. "-99" everywhere, Somaliland)
    const name = p.ADMIN || p.NAME || code;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates]
                : g.type === 'MultiPolygon' ? g.coordinates : null;
    if (!polys) continue;
    const rings = [];
    for (const poly of polys) for (const ring of poly) if (ring.length >= 4) rings.push(ring);
    if (!rings.length) continue;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const r of rings) for (const [x, y] of r) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    feats.push({ code, name, rings, bbox: [minX, minY, maxX, maxY] });
  }
  console.log('features with valid ISO code:', feats.length, '| skipped:', skipped);

  // --- rasterize --------------------------------------------------------
  const names = {};
  const grid = [];
  for (let y = 0; y < H; y++) {
    const lat = 90 - (y + 0.5) * (180 / H);
    for (let x = 0; x < W; x++) {
      const lon = -180 + (x + 0.5) * (360 / W);
      let code = null;
      for (const f of feats) {
        const [minX, minY, maxX, maxY] = f.bbox;
        if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
        let crossings = 0;
        for (const ring of f.rings) if (pointInRing(lon, lat, ring)) crossings++;
        if (crossings % 2 === 1) { code = f.code; names[code] = f.name; break; }
      }
      grid.push(code || '..');
    }
  }

  const aliases = { // 个别来源的国家码 -> ISO 3166-1 alpha-2
    UK: 'GB', EL: 'GR', AN: 'CW', CS: 'RS', YU: 'RS', SU: 'RU',
    TP: 'TL', ZR: 'CD', HV: 'BF', BU: 'MM', FX: 'FR', '00': 'AQ',
  };

  const out = { w: W, h: H, grid: grid.join(''), names, aliases };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');

  // --- stats / sanity checks -------------------------------------------
  const counts = {};
  for (const c of grid) counts[c] = (counts[c] || 0) + 1;
  const land = Object.keys(counts).filter((c) => c !== '..').length;
  console.log('land cells:', land, 'of', W * H, '| distinct codes:', Object.keys(counts).length);
  for (const code of ['US', 'CN', 'BR', 'IN', 'RU', 'AU', 'CA', 'FR', 'DE', 'GB', 'JP', 'AR', 'ZA', 'EG', 'MX', 'NZ', 'NO', 'ID', 'NG', 'CL']) {
    console.log(' ', code, (counts[code] || 0) + ' cells', names[code] || '(no name)');
  }
  const cellAt = (lon, lat) => grid[Math.floor((90 - lat) / (180 / H)) * W + Math.floor((lon + 180) / (360 / W))];
  console.log('spot checks ->');
  console.log('  Paris     (2.35, 48.86):', cellAt(2.35, 48.86));
  console.log('  New York  (-74.0, 40.7):', cellAt(-74.0, 40.7));
  console.log('  Tokyo     (139.7, 35.7):', cellAt(139.7, 35.7));
  console.log('  Sydney    (151.2, -33.9):', cellAt(151.2, -33.9));
  console.log('  Rio       (-43.2, -22.9):', cellAt(-43.2, -22.9));
  console.log('  mid-Pacific(-150, 0):', cellAt(-150, 0));
  console.log('  Antarctica (0, -85):', cellAt(0, -85));
}

main().catch((e) => { console.error(e); process.exit(1); });
