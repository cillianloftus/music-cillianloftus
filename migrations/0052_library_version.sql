-- Migration 0052: a version number for library changes rowids miss.
--
-- The cache stamps (src/lib/library-cache.ts, src/lib/page-cache.ts) read
-- each big table's highest rowid, which only moves when a row is added. It
-- misses rows taken away (re-deriving album genres deletes them all and
-- writes them again, and SQLite may give the new last row the old rowid),
-- and values filled in place (a birthday from an artist refresh, a label, a
-- date). Kept values that depend on those (genre counts, artist genres,
-- gaps, artist names) stayed stale until something else changed.
--
-- These triggers bump app_setting's library_version on each: a delete from
-- the catalogue tables, any change to an artist's other names, and an update
-- to an artist, edition or album. The stamps read it with the others
-- (CHANGE_VERSIONS). A migration that rebuilds one of these tables must
-- recreate its triggers.

INSERT OR IGNORE INTO app_setting (key, value) VALUES ('library_version', '0');

CREATE TRIGGER library_version_genre_tag_delete AFTER DELETE ON genre_tag
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_track_delete AFTER DELETE ON track
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_credit_delete AFTER DELETE ON artist_credit
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_recording_delete AFTER DELETE ON recording
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_release_delete AFTER DELETE ON release
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_release_update AFTER UPDATE ON release
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_group_delete AFTER DELETE ON release_group
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_group_update AFTER UPDATE ON release_group
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_artist_delete AFTER DELETE ON artist
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
-- What pages show, not bookkeeping (enriched_at, releases_checked_at are
-- written for every artist the nightly and official checks pass over).
CREATE TRIGGER library_version_artist_update
AFTER UPDATE OF name, sort_name, disambiguation, mbid, spotify_id, discogs_id, kind,
                begin_date, begin_precision, end_date, end_precision, area, wikidata_id,
                bio, bio_url, occupations, instruments
ON artist
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_alias_insert AFTER INSERT ON artist_alias
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_alias_delete AFTER DELETE ON artist_alias
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
