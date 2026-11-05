-- Migration number: 0015
--
-- Who an artist is, not only what they are credited on:
--   - kind: a person, a group, a duo, an orchestra, a choir...
--   - begin and end: born and died for a person, formed and dissolved for a
--     group, each with its precision like every other date
--   - area: where they are from
--   - aliases: other names one artist goes by (Quadeca is Benjamin Lasky),
--     so a credit under any of them finds the same artist
--   - links: how artists relate (a member of a group)
--   - images: pictures of them, with the credit each one needs
-- Filled from MusicBrainz and Wikidata by enrichment, filling nulls only;
-- anything set by hand is recorded in field_override and never replaced.

ALTER TABLE artist ADD COLUMN kind TEXT
    CHECK (kind IN ('person', 'group', 'duo', 'orchestra', 'choir', 'character', 'other'));

ALTER TABLE artist ADD COLUMN begin_date TEXT;
ALTER TABLE artist ADD COLUMN begin_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (begin_precision IN ('day', 'month', 'year', 'unknown'));
ALTER TABLE artist ADD COLUMN end_date TEXT;
ALTER TABLE artist ADD COLUMN end_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (end_precision IN ('day', 'month', 'year', 'unknown'));
ALTER TABLE artist ADD COLUMN area TEXT;
ALTER TABLE artist ADD COLUMN wikidata_id TEXT CHECK (wikidata_id IS NULL OR wikidata_id GLOB 'Q[0-9]*');
-- When enrichment last looked, so it does not ask again every night.
ALTER TABLE artist ADD COLUMN enriched_at TEXT;

-- A date and its precision agree, as everywhere else (0006).
CREATE TRIGGER artist_dates_insert
BEFORE INSERT ON artist
WHEN (NEW.begin_date IS NULL) <> (NEW.begin_precision = 'unknown')
  OR (NEW.end_date IS NULL) <> (NEW.end_precision = 'unknown')
BEGIN
    SELECT RAISE(ABORT, 'an artist date and its precision must agree');
END;

CREATE TRIGGER artist_dates_update
BEFORE UPDATE OF begin_date, begin_precision, end_date, end_precision ON artist
WHEN (NEW.begin_date IS NULL) <> (NEW.begin_precision = 'unknown')
  OR (NEW.end_date IS NULL) <> (NEW.end_precision = 'unknown')
BEGIN
    SELECT RAISE(ABORT, 'an artist date and its precision must agree');
END;


CREATE TABLE artist_alias (
    artist_id  TEXT NOT NULL REFERENCES artist (id),
    name       TEXT NOT NULL CHECK (name <> '') COLLATE NOCASE,
    kind       TEXT NOT NULL CHECK (kind IN ('legal', 'search', 'alias', 'performance')),
    source     TEXT NOT NULL CHECK (source IN ('musicbrainz', 'manual')),

    PRIMARY KEY (artist_id, name)
) STRICT;

CREATE INDEX artist_alias_name ON artist_alias (name);

-- Aliases are searchable, under the artist they belong to, with
-- apostrophes removed like every other indexed name (0009).
CREATE TRIGGER search_index_alias_insert
AFTER INSERT ON artist_alias
BEGIN
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', NEW.artist_id);
END;

CREATE TRIGGER search_index_alias_delete
AFTER DELETE ON artist_alias
BEGIN
    DELETE FROM search_index
    WHERE kind = 'artist' AND entity_id = OLD.artist_id AND name = replace(replace(replace(replace(OLD.name, '''', ''), '’', ''), '‘', ''), 'ʼ', '');
END;

-- Renaming an artist re-indexes their aliases too: 0009's trigger cleared
-- every index row for the artist, which would now take the aliases with it.
DROP TRIGGER artist_search_update;

CREATE TRIGGER artist_search_update AFTER UPDATE OF name ON artist
BEGIN
    DELETE FROM search_index WHERE kind = 'artist' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', NEW.id);
    INSERT INTO search_index (name, kind, entity_id)
    SELECT replace(replace(replace(replace(a.name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', NEW.id FROM artist_alias a WHERE a.artist_id = NEW.id;
END;


-- member_of: a person (or group) in a group; same_person: two records for
-- one person who are kept apart on purpose (a solo name and a real name
-- credited separately), shown together rather than merged.
CREATE TABLE artist_link (
    artist_id  TEXT NOT NULL REFERENCES artist (id),
    other_id   TEXT NOT NULL REFERENCES artist (id),
    kind       TEXT NOT NULL CHECK (kind IN ('member_of', 'same_person')),
    source     TEXT NOT NULL CHECK (source IN ('musicbrainz', 'manual')),
    begin_year INTEGER,
    end_year   INTEGER,

    PRIMARY KEY (artist_id, other_id, kind),
    CHECK (artist_id <> other_id)
) STRICT;

CREATE INDEX artist_link_other ON artist_link (other_id);


CREATE TABLE artist_image (
    id          TEXT PRIMARY KEY NOT NULL,
    artist_id   TEXT NOT NULL REFERENCES artist (id),
    -- R2 key of the stored copy.
    key         TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('wikimedia', 'spotify', 'manual')),
    -- Where it came from, and the credit its licence asks for.
    source_url  TEXT,
    credit      TEXT,
    licence     TEXT,
    width       INTEGER,
    height      INTEGER,
    position    INTEGER NOT NULL DEFAULT 0,
    hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),

    UNIQUE (artist_id, key)
) STRICT;

CREATE INDEX artist_image_artist ON artist_image (artist_id, position);
