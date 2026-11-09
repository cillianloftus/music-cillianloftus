-- Migration 0053: samples and interpolations between songs.
--
-- From Genius, which lists for each song what it samples and interpolates
-- and what samples and interpolates it. Most of those songs are not in the
-- library, so a link names both songs by their Genius page, with the title,
-- artist and year Genius gives; a track in the library joins in through
-- recording.genius_url. Keyed by page rather than recording id, a link made
-- when one song was looked up joins its other end whenever that is imported
-- and matched, and merges never touch it.
--
-- One row per link, in one direction: `song` samples or interpolates
-- `source`. "Sampled in" is the same row read from the other end.

CREATE TABLE song_link (
    kind TEXT NOT NULL CHECK (kind IN ('samples', 'interpolates')),
    song_url TEXT NOT NULL CHECK (song_url GLOB 'https://genius.com/*'),
    song_title TEXT NOT NULL,
    song_artist TEXT NOT NULL,
    song_year INTEGER,
    source_url TEXT NOT NULL CHECK (source_url GLOB 'https://genius.com/*'),
    source_title TEXT NOT NULL,
    source_artist TEXT NOT NULL,
    source_year INTEGER,
    found_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- An ordinary rowid table: backups page through tables by rowid.
    PRIMARY KEY (song_url, kind, source_url)
);

CREATE INDEX song_link_source ON song_link (source_url);

-- Tracks matched on Genius before links were kept are looked up again once
-- for theirs ('genius-links').
CREATE TABLE lookup_log_new (
    source     TEXT NOT NULL CHECK (source IN ('genius', 'genius-links', 'musicbrainz', 'spotify', 'deezer', 'itunes', 'wikipedia', 'discogs')),
    entity_id  TEXT NOT NULL,
    found      INTEGER NOT NULL CHECK (found IN (0, 1)),
    looked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, entity_id)
) STRICT;
INSERT INTO lookup_log_new SELECT source, entity_id, found, looked_at FROM lookup_log;
DROP TABLE lookup_log;
ALTER TABLE lookup_log_new RENAME TO lookup_log;

-- Library tracks by Genius page, for joining links to them.
CREATE INDEX recording_genius_url ON recording (genius_url) WHERE genius_url IS NOT NULL;

-- A new link, or a track's Genius page found, changes what track pages show.
CREATE TRIGGER library_version_song_link_insert AFTER INSERT ON song_link
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_recording_genius AFTER UPDATE OF genius_url ON recording
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
