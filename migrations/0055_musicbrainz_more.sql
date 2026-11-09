-- Migration 0055: more from MusicBrainz, from one more look at each album
-- (src/lib/sources/musicbrainz-more.ts).
--
-- Tracks: whether a recording is a cover, live or an instrumental (the
--   attributes on its link to the song it performs), and MusicBrainz's
--   community rating. Each track's own genres go into genre_tag as before.
-- Albums: the community rating, and the lists and series they are part of
--   ("Rolling Stone's 500 Greatest Albums", a Mercury Prize shortlist).
-- Editions: their labels as labels (not only a name), with the catalogue
--   number, and the packaging.
--
-- Fill only, like every import: nothing set by hand is written over.

ALTER TABLE recording ADD COLUMN is_cover INTEGER CHECK (is_cover IS NULL OR is_cover IN (0, 1));
ALTER TABLE recording ADD COLUMN is_live INTEGER CHECK (is_live IS NULL OR is_live IN (0, 1));
ALTER TABLE recording ADD COLUMN is_instrumental INTEGER CHECK (is_instrumental IS NULL OR is_instrumental IN (0, 1));
-- MusicBrainz's 0–5 community rating and how many voted.
ALTER TABLE recording ADD COLUMN mb_rating REAL CHECK (mb_rating IS NULL OR mb_rating BETWEEN 0 AND 5);
ALTER TABLE recording ADD COLUMN mb_rating_votes INTEGER;
ALTER TABLE release_group ADD COLUMN mb_rating REAL CHECK (mb_rating IS NULL OR mb_rating BETWEEN 0 AND 5);
ALTER TABLE release_group ADD COLUMN mb_rating_votes INTEGER;
ALTER TABLE release ADD COLUMN packaging TEXT;

CREATE TABLE label (
    id             TEXT PRIMARY KEY NOT NULL,
    mbid           TEXT UNIQUE,
    name           TEXT NOT NULL,
    sort_name      TEXT,
    disambiguation TEXT,
    -- "Original Production", "Imprint", "Holding"…
    type           TEXT,
    -- The LC number printed on releases.
    label_code     INTEGER,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX label_name ON label (name COLLATE NOCASE);

-- An edition's labels, each with its catalogue number there.
CREATE TABLE release_label (
    release_id     TEXT NOT NULL REFERENCES release (id) ON DELETE CASCADE,
    label_id       TEXT NOT NULL REFERENCES label (id),
    catalog_number TEXT,
    PRIMARY KEY (release_id, label_id)
) STRICT;

CREATE INDEX release_label_label ON release_label (label_id);

CREATE TABLE series (
    id     TEXT PRIMARY KEY NOT NULL,
    mbid   TEXT UNIQUE,
    name   TEXT NOT NULL,
    -- "Release group award", "Release group list"…
    type   TEXT
) STRICT;

-- An album's place in a list or series, with its number there when it has one.
CREATE TABLE release_group_series (
    release_group_id TEXT NOT NULL REFERENCES release_group (id) ON DELETE CASCADE,
    series_id        TEXT NOT NULL REFERENCES series (id),
    number           TEXT,
    PRIMARY KEY (release_group_id, series_id)
) STRICT;

CREATE INDEX release_group_series_series ON release_group_series (series_id);

-- Pages show all of these: the cache stamps move with them.
CREATE TRIGGER library_version_release_label AFTER INSERT ON release_label
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_release_group_series AFTER INSERT ON release_group_series
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER library_version_recording_more
AFTER UPDATE OF is_cover, is_live, is_instrumental, mb_rating ON recording
WHEN OLD.is_cover IS NOT NEW.is_cover OR OLD.is_live IS NOT NEW.is_live OR OLD.is_instrumental IS NOT NEW.is_instrumental
  OR OLD.mb_rating IS NOT NEW.mb_rating
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
