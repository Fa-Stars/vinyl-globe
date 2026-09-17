'use strict';

// Jamendo exposes the Creative Commons URL as metadata on each track.  Keep
// the accepted grammar deliberately small: the player needs a trustworthy
// attribution link, not an arbitrary URL that happens to contain "creative".
const LICENSE_SLUGS = new Map([
  ['by', 'CC BY'],
  ['by-sa', 'CC BY-SA'],
  ['by-nd', 'CC BY-ND'],
  ['by-nc', 'CC BY-NC'],
  ['by-nc-sa', 'CC BY-NC-SA'],
  ['by-nc-nd', 'CC BY-NC-ND'],
]);
const LICENSE_VERSIONS = new Set(['1.0', '2.0', '2.5', '3.0', '4.0']);
const LICENSE_HOSTS = new Set(['creativecommons.org', 'www.creativecommons.org']);

function normalizeLicensePath(pathname) {
  // URL.pathname is already decoded for ordinary characters, but reject
  // encoded slashes and other encoded path tricks rather than interpreting
  // them as a second path segment.
  if (/%2f|%5c/i.test(pathname)) return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'licenses') return null;

  const slug = parts[1].toLowerCase();
  const version = parts[2];
  if (!LICENSE_SLUGS.has(slug) || !LICENSE_VERSIONS.has(version)) return null;

  const suffixes = parts.slice(3);
  if (suffixes.length > 1 ||
      (suffixes.length === 1 && !/^deed\.[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(suffixes[0]))) {
    return null;
  }

  // Localized deed pages are still standard Creative Commons license URLs.
  // They do not change the underlying license identity, so the locale is
  // intentionally omitted from the normalized URL.
  const pathParts = ['licenses', slug, version];
  return {
    name: LICENSE_SLUGS.get(slug) + ' ' + version,
    url: 'https://creativecommons.org/' + pathParts.join('/') + '/',
  };
}

function normalizeJamendoLicense(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const authorityMatch = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw);
  const authority = authorityMatch && authorityMatch[1];
  // WHATWG URL omits an explicit default port from .port. Inspect the raw
  // authority too, because a license URL with any explicit port is outside
  // the canonical host grammar.
  if (authority && authority.includes(':')) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      !LICENSE_HOSTS.has(parsed.hostname.toLowerCase()) ||
      parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  return normalizeLicensePath(parsed.pathname);
}

function normalizedNumericId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(id)) return '';
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : '';
}

function normalizeJamendoShareUrl(value, id) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const raw = value.trim();
  const authorityMatch = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(raw);
  if (authorityMatch && authorityMatch[1].includes(':')) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol) ||
      !['jamendo.com', 'www.jamendo.com'].includes(parsed.hostname.toLowerCase()) ||
      parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return '';
  }
  const match = /^\/track\/(\d+)\/?$/i.exec(parsed.pathname);
  if (!match || normalizedNumericId(match[1]) !== id) return '';
  return 'https://www.jamendo.com/track/' + id;
}

function normalizeJamendoTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const id = normalizedNumericId(track.id);
  const audio = typeof track.audio === 'string' ? track.audio.trim() : '';
  const license = normalizeJamendoLicense(track.license_ccurl);
  if (!id || !audio || !license) return null;

  let audioUrl;
  try {
    audioUrl = new URL(audio);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(audioUrl.protocol)) return null;

  const duration = Number(track.duration);
  const sourceUrl = normalizeJamendoShareUrl(track.shareurl, id) ||
    'https://www.jamendo.com/track/' + id;
  return {
    id,
    title: String(track.name || track.title || '未知歌曲'),
    artist: String(track.artist_name || track.artist || '未知歌手'),
    artistId: String(track.artist_id || '').trim(),
    album: String(track.album_name || track.album || ''),
    streamUrl: audio,
    artwork: String(track.album_image || track.image || track.artwork || ''),
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    countrycode: '',
    country: '未知地区',
    sourceUrl,
    license,
  };
}

module.exports = {
  normalizeJamendoLicense,
  normalizeJamendoShareUrl,
  normalizeJamendoTrack,
};
