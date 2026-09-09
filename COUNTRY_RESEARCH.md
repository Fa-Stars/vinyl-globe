# Country evidence research — 2026-09-08

The coverage figures below describe a historical verification sample, not the
player's selection range. The player now samples random positions in Jamendo's
live catalog, including singles and album tracks, and continuously replaces a
six-song look-ahead buffer. Country evidence never determines which track is
selected. See the [official track endpoint](https://developer.jamendo.com/v3.0/tracks)
for `fullcount`, `offset`, `type` and ordering semantics, and the
[artist location endpoint](https://developer.jamendo.com/v3.0/artists/locations)
for batch lookup by artist IDs.

A live verification returned a catalog size of 856,276 tracks. Four random
positions produced Giovanni Anastasi, SONIC MYSTERY, Tomasz Raszko and
CachaTeleFunken in 21.3 seconds; the subsequent single location request returned
Italy, Slovenia, Poland and Spain in 254 ms. These are one-run measurements,
not a latency guarantee. Deep catalog pagination remains the slower operation;
the small rolling buffer overlaps it with current playback.

The bundled mappings in `web/verified-artist-countries.json` record evidence URLs and identity checks. These identify the artist's musical base/origin region, not the language of the song, recording location, citizenship, or ethnicity. Locations of artist-controlled profiles are accepted; birthplace/origin is preferred when explicitly documented. The lookup must not infer from an artist's name alone.

The first research pass added 18 verified names, covering 59 previously unknown tracks in the inspected 360-track pool. A second pass added six more names (eight tracks) below. All 24 entries have scoped Jamendo artist IDs and track IDs from the retrieved catalogue. Most evidence comes from artist-controlled SoundCloud, Bandcamp, Myspace, ReverbNation or official band websites. Jasmine Jordan, Robert Avellanet and The Very Sexuals are supported by direct interviews identifying the relevant release. StrangeZero uses its EP distribution partner's biography and an artist-controlled track identity cross-check. Full evidence and links are stored with each mapping.

## Second pass: remaining artists after official Jamendo locations

- Pokki DJ: IT, Imperia. [Contest organizer announcement](https://www.prweb.com/releases/Canadian_Country_Artist_Eric_Ethridge_Wins_Prestigious_Grand_Prize_in_2018_Unsigned_Only_Music_Competition/prweb15706776.htm), matched Energy on artist SoundCloud and distributor catalogue.
- Paul Lisak & After The Ice: GB, London. [Band's self-written BandMix profile](https://www.bandmix.co.uk/aftertheice-band/) states permanent members live in Leytonstone and identifies Paul Lisak. This is the band's base, despite the singer's French birthplace.
- Moon & Sun: NL. [Artist Bandcamp's exact Salt & Indigo page](https://moonandsun.bandcamp.com/track/salt-indigo) states Amsterdam, Netherlands. Monica Tormell is Swedish, so this explicitly uses the musical project's reference location.
- Jesta: GB. [Own Bandcamp album Previously...](https://jesta.bandcamp.com/album/previously) contains Back Chat and identifies UK musician Bryan Page. Unrelated same-name rappers were rejected.
- the saymory: UA. [Band's ReverbNation profile](https://www.reverbnation.com/saymory) says Kharkov, UA and contains the exact Dr.synthetique remix of The Mirror Of You. This historical band should not inherit the later solo artist's Berlin address.
- Przemek Puk: PL. [Official studio](https://pukmusic.pl/) lists Warsaw; artist Linktree and record label link the studio to him. [Original artist video](https://www.youtube.com/watch?v=nmUl2p8kGTU) matches Ocean Lez.

Tryad's official Jamendo US reference location can be used if the product consistently defines the field as artist reference location. It should not be presented as nationality or imply the entire international collaboration is from only one country.

Silence is now verified as BE by the official Jamendo artist-location endpoint for artist ID 245, stored in `web/jamendo-country-seed.json`; this supersedes the earlier manual-search uncertainty. A [contemporaneous 2006 album review](https://www.macplus.net/depeche-28467-l-autre-endroit) independently identifies Belgian origin and the exact album. The official Jamendo metadata is an artist self-declared reference location, not evidence of passport nationality.

The final combined API audit resolves **359 of 360 tracks (99.7%)** using the official Jamendo seed and identity-scoped manual evidence. **One track remains unknown: Javier Jerez — Dos Diamantes (artist 438201, track 1071847).** His official endpoint has an empty locations array and no website. A [2013 concert announcement](https://elecodelosbarros.blogspot.com/2013_11_12_archive.html) matches the album but performing in Spain alone cannot establish origin/base.

## Identity cautions and earlier unresolved cases

- **Tryad** (13 tracks in the inspected pool): its [own Bandcamp biography](https://tryad.bandcamp.com/) calls the project an international collaboration of musicians around the world. [Jamendo's incubator report from 2006](https://www.technoport.lu/online/www/datapool/84/2401/2413/802/ENG/AnnualReport2006.pdf) labels Try^ad US, but the artist's own description does not justify one unqualified country. Consider a distinct international/collaboration display value in future.
- **Silence** (9 tracks): pool is *L'autre endroit*, not the Slovenian band also called Silence. The official ID-scoped Jamendo location now confirms BE; no manual mapping is needed. [NTS](https://www.nts.live/artists/246458-silence) associates that release with Belgian Vincent Gires, and [a specialist album write-up](https://hbbfreemusic.blogspot.com/2013/) identifies Vincent Gires and the matching tracklist.
- **Mistery** (6 tracks): multiple unrelated Brazilian, Italian and Australian artists share this name. Jamendo material credits C. Rizzo; popular search hits for the unrelated artists must not be applied.
- **Lollita**, **Hiroumi**, **Olga Zhilkova**, **Malika Rai**, **Chasing Eidolon**: the first manual search did not produce sufficiently attributable location evidence. Later official Jamendo metadata resolved all of these except Lollita. Names/languages alone were not used.
- **Manhat10**: a different Khabarovsk cover band appears in search. The verified mapping uses the Moscow Bandcamp project and cross-checks the SoundCloud release titles that appear in the pool.
- **Robert Avellanet**: Puerto Rico is the evidenced origin region even though he later lived in Los Angeles. Preserve PR as a region code rather than silently replacing it with the US.

## Additional promising evidence

- [Josh Woodward's domain-verified Bluesky profile](https://bsky.app/profile/joshwoodward.com) identifies Ann Arbor. Direct official website access returned 403 during this pass; search results also contain unrelated photographers and a movie producer with this name.

Research limitations: web search is incomplete; official Jamendo artist location metadata should be preferred where available. Artist profiles can record current residence and can change, so evidence and review date must remain available. An unknown is preferable to a confidently mislabeled country.

## Historical region-code correction

[Jamendo artist 368292](https://www.jamendo.com/artist/368292), Lollita, declares country ANT and locality sint maarten in the official artists/locations API. ANT is a historical Netherlands Antilles code. The exact locality disambiguates Sint Maarten (SX), per [ISO newsletter VI-8](https://www.iso.org/files/live/sites/isoorg/files/archive/pdf/en/iso_3166-1_newsletter_vi-8_split_of_the_dutch_antilles_final-en.pdf). This resolves all eight Lollita tracks. The resolver does not map ANT without an identifying locality. [UNData](https://data.un.org/en/iso/sx.html) identifies Philipsburg as the capital; its [Apple Maps coordinates](https://maps.apple.com/place?auid=7957586070577928412) are used for the globe signal point.
