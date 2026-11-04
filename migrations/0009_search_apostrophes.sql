-- Migration number: 0009
--
-- The unicode61 tokenizer splits words at apostrophes, so "Didn’t" was
-- indexed as "didn" + "t" and a search for "didnt" found nothing. Index
-- names with apostrophes removed (straight, curly and modifier letter);
-- src/lib/search.ts strips them from queries the same way.

DROP TRIGGER artist_search_insert;
DROP TRIGGER artist_search_update;
DROP TRIGGER release_group_search_insert;
DROP TRIGGER release_group_search_update;
DROP TRIGGER recording_search_insert;
DROP TRIGGER recording_search_update;

DELETE FROM search_index;

INSERT INTO search_index (name, kind, entity_id)
SELECT replace(replace(replace(replace(name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', id FROM artist;
INSERT INTO search_index (name, kind, entity_id)
SELECT replace(replace(replace(replace(title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'release_group', id FROM release_group;
INSERT INTO search_index (name, kind, entity_id)
SELECT replace(replace(replace(replace(title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'recording', id FROM recording;

CREATE TRIGGER artist_search_insert AFTER INSERT ON artist
BEGIN
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', NEW.id);
END;

CREATE TRIGGER artist_search_update AFTER UPDATE OF name ON artist
BEGIN
    DELETE FROM search_index WHERE kind = 'artist' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.name, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'artist', NEW.id);
END;

CREATE TRIGGER release_group_search_insert AFTER INSERT ON release_group
BEGIN
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'release_group', NEW.id);
END;

CREATE TRIGGER release_group_search_update AFTER UPDATE OF title ON release_group
BEGIN
    DELETE FROM search_index WHERE kind = 'release_group' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'release_group', NEW.id);
END;

CREATE TRIGGER recording_search_insert AFTER INSERT ON recording
BEGIN
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'recording', NEW.id);
END;

CREATE TRIGGER recording_search_update AFTER UPDATE OF title ON recording
BEGIN
    DELETE FROM search_index WHERE kind = 'recording' AND entity_id = OLD.id;
    INSERT INTO search_index (name, kind, entity_id)
    VALUES (replace(replace(replace(replace(NEW.title, '''', ''), '’', ''), '‘', ''), 'ʼ', ''), 'recording', NEW.id);
END;
