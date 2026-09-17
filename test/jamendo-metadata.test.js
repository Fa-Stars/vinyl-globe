'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeJamendoLicense,
  normalizeJamendoShareUrl,
  normalizeJamendoTrack,
} = require('../web/jamendo-metadata');

test('normalizes recognized Creative Commons licenses to a safe canonical URL', () => {
  assert.deepEqual(normalizeJamendoLicense('https://creativecommons.org/licenses/by-nc-sa/3.0/'), {
    name: 'CC BY-NC-SA 3.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
  });
  assert.deepEqual(normalizeJamendoLicense('https://www.creativecommons.org/licenses/by/4.0/deed.en'), {
    name: 'CC BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  });
});

test('rejects malicious or ambiguous license URLs', () => {
  for (const value of [
    '',
    'javascript:alert(1)',
    'https://evil.example/creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org.evil.example/licenses/by/4.0/',
    'https://user:pass@creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org:444/licenses/by/4.0/',
    'https://creativecommons.org:443/licenses/by/4.0/',
    'https://creativecommons.org/licenses/by/4.0/xx/',
    'https://creativecommons.org/licenses/by/3.0/us/',
    'https://creativecommons.org/licenses/by/4.0/deed.en/deed.zh/',
    'https://creativecommons.org/licenses/by/4.0/?next=https://evil.example',
    'https://creativecommons.org/licenses/by/4.0/%2f..%2fevil',
    'https://creativecommons.org/licenses/unknown/4.0/',
    'https://creativecommons.org/licenses/by/9.0/',
  ]) assert.equal(normalizeJamendoLicense(value), null, value);
});

test('canonicalizes a numeric Jamendo track page and rejects unrelated pages', () => {
  assert.equal(
    normalizeJamendoShareUrl('https://www.jamendo.com/track/00123/', '123'),
    'https://www.jamendo.com/track/123',
  );
  assert.equal(normalizeJamendoShareUrl('https://www.jamendo.com/track/124', '123'), '');
  assert.equal(normalizeJamendoShareUrl('https://evil.example/track/123', '123'), '');
});

test('normalizes only numeric licensed tracks and preserves attribution fields', () => {
  const normalized = normalizeJamendoTrack({
    id: '00123',
    name: 'A Song',
    artist_id: '55',
    artist_name: 'An Artist',
    album_name: 'An Album',
    audio: 'https://api.jamendo.com/files/song.mp3',
    duration: '42',
    license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
    shareurl: 'https://www.jamendo.com/track/123',
  });
  assert.equal(normalized.id, '123');
  assert.equal(normalized.sourceUrl, 'https://www.jamendo.com/track/123');
  assert.deepEqual(normalized.license, { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' });
  assert.equal(normalized.duration, 42);
  assert.equal(normalizeJamendoTrack({
    id: '123', audio: 'https://api.jamendo.com/files/song.mp3', license_ccurl: 'https://evil.example/by/4.0/',
  }), null);
  assert.equal(normalizeJamendoTrack({
    id: 'not-numeric', audio: 'https://api.jamendo.com/files/song.mp3', license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
  }), null);
});
