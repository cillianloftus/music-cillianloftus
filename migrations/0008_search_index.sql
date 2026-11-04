-- Migration number: 0008
--
-- Plain text search (ARCHITECTURE.md §4, Plain search): one full-text
-- index over artist, album and track names, kept in sync by triggers.
--
-- unicode61 with remove_diacritics folds accents, so "bjork" finds Björk
-- and "sigur ros" finds Sigur Rós. Prefix indexes make the 2–3 character
-- prefixes typed while searching cheap.
--
-- The index is derived data. Backups skip it (wrangler d1 export cannot
-- dump virtual tables anyway); it is rebuilt by re-running the INSERTs below.

CREATE VIRTUAL TABLE search_index USING fts5(
    name,
    kind UNINDEXED,
    entity_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);

INSERT INTO search_index (name, kind, entity_id) SELECT name, 'artist', id FROM artist;
INSERT INTO search_index (name, kind, entity_id) SELECT title, 'release_group', id FROM release_group;
INSERT INTO search_index (name, kind, entity_id) SELECT title, 'recording', id FROM recording;


CREATE TRIGGER artist_search_insert AFTER INSERT ON artist
BEGIN
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.name, 'artist', NEW.id);
END;

CREATE TRIGGER artist_search_update AFTER UPDATE OF name ON artist
BEGIN
    DELETE FROM search_index WHERE kind = 'artist' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.name, 'artist', NEW.id);
END;

CREATE TRIGGER release_group_search_insert AFTER INSERT ON release_group
BEGIN
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.title, 'release_group', NEW.id);
END;

CREATE TRIGGER release_group_search_update AFTER UPDATE OF title ON release_group
BEGIN
    DELETE FROM search_index WHERE kind = 'release_group' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.title, 'release_group', NEW.id);
END;

CREATE TRIGGER recording_search_insert AFTER INSERT ON recording
BEGIN
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.title, 'recording', NEW.id);
END;

CREATE TRIGGER recording_search_update AFTER UPDATE OF title ON recording
BEGIN
    DELETE FROM search_index WHERE kind = 'recording' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id) VALUES (NEW.title, 'recording', NEW.id);
END;
