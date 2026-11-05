-- Migration number: 0025
--
-- Artist pictures from Deezer and Genius too. SQLite cannot alter a CHECK,
-- so artist_image is rebuilt with the wider list; nothing refers to it.
CREATE TABLE artist_image_new (
    id          TEXT PRIMARY KEY NOT NULL,
    artist_id   TEXT NOT NULL REFERENCES artist (id),
    key         TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('wikimedia', 'spotify', 'deezer', 'genius', 'manual')),
    source_url  TEXT,
    credit      TEXT,
    licence     TEXT,
    width       INTEGER,
    height      INTEGER,
    position    INTEGER NOT NULL DEFAULT 0,
    hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),

    UNIQUE (artist_id, key)
) STRICT;

INSERT INTO artist_image_new SELECT id, artist_id, key, source, source_url, credit, licence, width, height, position, hidden FROM artist_image;
DROP TABLE artist_image;
ALTER TABLE artist_image_new RENAME TO artist_image;
CREATE INDEX artist_image_artist ON artist_image (artist_id, position);
