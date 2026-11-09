-- Migration 0056: what Wikidata says of an artist beyond what they do and
-- play (src/lib/sources/wikipedia.ts): awards received and nominated for
-- (with the year), record labels, who influenced them, where they were
-- born and died, where they studied, their citizenship and nicknames.
--
-- One row per statement. `value_id` is the Wikidata item the statement
-- names (Q…), so an influence that is an artist in the library joins it
-- through artist.wikidata_id, both ways; a nickname is text and has none.
-- Refilled whole for an artist on each look (Wikidata is the source).

CREATE TABLE artist_fact (
    artist_id  TEXT NOT NULL REFERENCES artist (id) ON DELETE CASCADE,
    property   TEXT NOT NULL CHECK (property IN (
        'award', 'nomination', 'label', 'influenced_by', 'birthplace', 'deathplace', 'educated_at', 'citizenship', 'nickname')),
    -- The item named, or the nickname itself for a nickname.
    value_id   TEXT NOT NULL,
    label      TEXT NOT NULL,
    year       INTEGER,
    PRIMARY KEY (artist_id, property, value_id)
) STRICT;

CREATE INDEX artist_fact_value ON artist_fact (property, value_id);
CREATE INDEX artist_wikidata ON artist (wikidata_id) WHERE wikidata_id IS NOT NULL;

CREATE TRIGGER library_version_artist_fact_insert AFTER INSERT ON artist_fact
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_artist_fact_delete AFTER DELETE ON artist_fact
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
