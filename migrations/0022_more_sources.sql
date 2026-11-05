-- Migration number: 0022
--
-- More outside sources: Deezer (labels, barcodes), iTunes (covers),
-- Wikipedia (artist bios), and Genius pages (for a lyrics link; the lyrics
-- themselves are never fetched or stored).

ALTER TABLE release ADD COLUMN barcode TEXT CHECK (barcode GLOB '[0-9]*' AND length(barcode) BETWEEN 8 AND 14);
ALTER TABLE recording ADD COLUMN genius_url TEXT CHECK (genius_url GLOB 'https://genius.com/*');
ALTER TABLE artist ADD COLUMN bio TEXT CHECK (length(bio) <= 2000);
ALTER TABLE artist ADD COLUMN bio_url TEXT CHECK (bio_url GLOB 'https://*.wikipedia.org/*');

-- lookup_log learns the new sources. SQLite cannot alter a CHECK: rebuilt.
CREATE TABLE lookup_log_new (
    source     TEXT NOT NULL CHECK (source IN ('genius', 'musicbrainz', 'spotify', 'deezer', 'itunes', 'wikipedia')),
    entity_id  TEXT NOT NULL,
    found      INTEGER NOT NULL CHECK (found IN (0, 1)),
    looked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, entity_id)
) STRICT;
INSERT INTO lookup_log_new SELECT source, entity_id, found, looked_at FROM lookup_log;
DROP TABLE lookup_log;
ALTER TABLE lookup_log_new RENAME TO lookup_log;

-- Where an artist is on the web: official site and profiles, from MusicBrainz.
CREATE TABLE artist_url (
    artist_id  TEXT NOT NULL REFERENCES artist (id),
    kind       TEXT NOT NULL CHECK (kind IN ('website', 'instagram', 'x', 'youtube', 'tiktok', 'bandcamp', 'soundcloud', 'facebook', 'genius', 'other')),
    url        TEXT NOT NULL CHECK (url GLOB 'https://*' OR url GLOB 'http://*'),
    source     TEXT NOT NULL DEFAULT 'musicbrainz',
    PRIMARY KEY (artist_id, url)
) STRICT;

-- What they do, from Wikidata, as JSON arrays of labels: ["singer", "record producer"].
ALTER TABLE artist ADD COLUMN occupations TEXT CHECK (occupations IS NULL OR json_valid(occupations));
ALTER TABLE artist ADD COLUMN instruments TEXT CHECK (instruments IS NULL OR json_valid(instruments));
