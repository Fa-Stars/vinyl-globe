'use strict';

const regionDisplayNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

const AREA_NAME_ALIASES = Object.freeze({
  'czech republic': 'CZ',
  'iran, islamic republic of': 'IR',
  'russian federation': 'RU',
  'south korea': 'KR',
  'united states of america': 'US',
  'vatican city': 'VA',
});

function normalizeLabel(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

function countryCodeFromAreaName(name, countryNames) {
  const wanted = normalizeLabel(name);
  if (!wanted || !countryNames || typeof countryNames !== 'object') return '';
  const alias = AREA_NAME_ALIASES[wanted];
  if (alias && countryNames[alias]) return alias;
  for (const code of Object.keys(countryNames)) {
    let displayName = '';
    try {
      displayName = regionDisplayNames ? regionDisplayNames.of(code) : '';
    } catch (e) { /* ignore an invalid/non-standard region code */ }
    if (normalizeLabel(displayName) === wanted) return code;
  }
  return '';
}

// MusicBrainz uses the JSON key "iso-3166-1-codes". Keep the legacy
// underscore spelling as a compatibility fallback for saved fixtures.
function isoCodeFromArea(area) {
  if (!area || typeof area !== 'object') return '';
  for (const key of ['iso-3166-1-codes', 'iso_3166_1_codes']) {
    const value = area[key];
    const code = Array.isArray(value) ? value[0] : value;
    if (typeof code === 'string' && code.trim()) return code.trim().toUpperCase();
  }
  return '';
}

function extractMusicBrainzCountryCode(artist, countryNames) {
  if (!artist || typeof artist !== 'object') return null;
  const area = artist.area;
  const beginArea = artist['begin-area'];
  const candidates = [
    isoCodeFromArea(area),
    countryCodeFromAreaName(area && area.name, countryNames),
    typeof artist.country === 'string' ? artist.country.trim().toUpperCase() : '',
    isoCodeFromArea(beginArea),
    countryCodeFromAreaName(beginArea && beginArea.name, countryNames),
  ];
  return candidates.find((code) => /^[A-Z]{2}$/.test(code) && countryNames[code]) || null;
}

function selectMusicBrainzCountryCode(artists, requestedName, countryNames) {
  const wanted = normalizeLabel(requestedName);
  if (!wanted || !Array.isArray(artists)) return null;
  const codes = artists
    .filter((artist) => normalizeLabel(artist && artist.name) === wanted)
    .map((artist) => extractMusicBrainzCountryCode(artist, countryNames))
    .filter(Boolean);
  const unique = [...new Set(codes)];
  return unique.length === 1 ? unique[0] : null;
}

function selectMusicBrainzArtist(artists, requestedName) {
  const wanted = normalizeLabel(requestedName);
  if (!wanted || !Array.isArray(artists)) return null;
  const exact = artists.filter((artist) => normalizeLabel(artist && artist.name) === wanted);
  return exact.length === 1 ? exact[0] : null;
}

module.exports = {
  extractMusicBrainzCountryCode,
  selectMusicBrainzArtist,
  selectMusicBrainzCountryCode,
};
