'use strict';

// Jamendo /artists/locations uses ISO 3166-1 alpha-3, the globe uses alpha-2.
const ISO = Object.fromEntries(('AFG:AF ALB:AL DZA:DZ AND:AD AGO:AO ARG:AR ARM:AM AUS:AU AUT:AT AZE:AZ BHS:BS BHR:BH BGD:BD BLR:BY BEL:BE BLZ:BZ BEN:BJ BTN:BT BOL:BO BIH:BA BWA:BW BRA:BR BRN:BN BGR:BG BFA:BF BDI:BI KHM:KH CMR:CM CAN:CA CPV:CV CAF:CF TCD:TD CHL:CL CHN:CN COL:CO COM:KM COG:CG COD:CD CRI:CR CIV:CI HRV:HR CUB:CU CYP:CY CZE:CZ DNK:DK DJI:DJ DOM:DO ECU:EC EGY:EG SLV:SV GNQ:GQ ERI:ER EST:EE ETH:ET FIN:FI FRA:FR GAB:GA GMB:GM GEO:GE DEU:DE GHA:GH GRC:GR GRL:GL GTM:GT GIN:GN GNB:GW GUY:GY HTI:HT HND:HN HKG:HK HUN:HU ISL:IS IND:IN IDN:ID IRN:IR IRQ:IQ IRL:IE ISR:IL ITA:IT JAM:JM JPN:JP JOR:JO KAZ:KZ KEN:KE PRK:KP KOR:KR XKK:XK KWT:KW KGZ:KG LAO:LA LVA:LV LBN:LB LSO:LS LBR:LR LBY:LY LIE:LI LTU:LT LUX:LU MAC:MO MKD:MK MDG:MG MWI:MW MYS:MY MDV:MV MLI:ML MLT:MT MRT:MR MUS:MU MEX:MX MDA:MD MCO:MC MNG:MN MNE:ME MAR:MA MOZ:MZ MMR:MM NAM:NA NPL:NP NLD:NL NZL:NZ NIC:NI NER:NE NGA:NG NOR:NO OMN:OM PAK:PK PSE:PS PAN:PA PNG:PG PRY:PY PER:PE PHL:PH POL:PL PRT:PT PRI:PR QAT:QA ROU:RO RUS:RU RWA:RW SAU:SA SEN:SN SRB:RS SLE:SL SGP:SG SVK:SK SVN:SI SOM:SO ZAF:ZA SSD:SS ESP:ES LKA:LK SDN:SD SUR:SR SWZ:SZ SWE:SE CHE:CH SYR:SY TWN:TW TJK:TJ TZA:TZ THA:TH TLS:TL TGO:TG TTO:TT TUN:TN TUR:TR TKM:TM UGA:UG UKR:UA ARE:AE GBR:GB USA:US URY:UY UZB:UZ VEN:VE VNM:VN ESH:EH YEM:YE ZMB:ZM ZWE:ZW').split(' ').map(pair => pair.split(':')));
const normalize = name => String(name || '').replace(/&amp;/gi, '&').trim().replace(/\s+/g, ' ').toLowerCase();
Object.assign(ISO, Object.fromEntries('ATG:AG AIA:AI BRB:BB BMU:BM DMA:DM FJI:FJ GRD:GD KNA:KN CYM:KY LCA:LC MSR:MS PLW:PW SLB:SB SYC:SC STP:ST TCA:TC VCT:VC VGB:VG'.split(' ').map(pair => pair.split(':'))));

function selectLocation(artists, name, artistId, countries) {
  const exact = artists.filter(a => normalize(a.name) === normalize(name) && (!artistId || String(a.id) === String(artistId)));
  if (exact.length !== 1) return null;
  const artist = exact[0];
  const locations = artist.locations || [];
  // Historical ANT covered several islands. Only migrate when the declared
  // locality disambiguates Sint Maarten; ANT alone must remain unknown.
  // ISO 3166-1 newsletter VI-8 assigns SX/SXM to Sint Maarten.
  const codes = locations.map(l => l.country === 'ANT' && normalize(l.city) === 'sint maarten'
    ? 'SX' : ISO[l.country] || (l.country === 'SXM' ? 'SX' : /^[A-Z]{2}$/.test(l.country) ? l.country : null));
  const unique = [...new Set(codes)];
  if (unique.length !== 1 || !countries[unique[0]]) return null;
  return { code: unique[0], source: 'jamendo', sourceUrl: 'https://www.jamendo.com/artist/' + encodeURIComponent(artist.id), artistId: String(artist.id) };
}

async function lookupJamendoCountry(name, artistId, { clientId, countries, fetchJson }) {
  if (!clientId) return { code: null, definitive: true };
  const request = async (endpoint, params) => fetchJson('https://api.jamendo.com/v3.0/' + endpoint + '/?' + new URLSearchParams({client_id: clientId, format: 'json', limit: '200', ...params}));
  try {
    // Resolve an old pool's missing artist ID first; /locations name search can return empty.
    if (!artistId) {
      const result = await request('artists', {name});
      if (result.headers?.status !== 'success') return {code: null, definitive: false};
      const exact = (result.results || []).filter(a => normalize(a.name) === normalize(name));
      if (exact.length !== 1) return {code: null, definitive: true};
      artistId = exact[0].id;
    }
    const result = await request('artists/locations', {id: String(artistId)});
    if (result.headers?.status !== 'success') return {code: null, definitive: false};
    return {...(selectLocation(result.results || [], name, artistId, countries) || {code: null}), definitive: true};
  } catch (_) {
    return {code: null, definitive: false};
  }
}

module.exports = { lookupJamendoCountry, selectLocation, countryCodes: [...new Set([...Object.values(ISO), 'SX'])] };
