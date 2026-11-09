-- Migration 0049: version numbers for what changes in place.
--
-- The page cache (src/lib/page-cache.ts) and the library cache
-- (src/lib/library-cache.ts) key everything on a stamp of the library's
-- state, worked out before every cached read. Tables only added to cost
-- one seek each (their highest rowid), but three things change in place
-- and were counted whole every time: covers (every release, 1,933 rows),
-- artist pictures (1,715) and the genre tree (287). That was about 4,000
-- rows a stamp, most of what a cached page costs.
--
-- Now each bumps a number in app_setting when it changes, and a stamp
-- reads those numbers: a few rows. Each trigger inserts its row if it is
-- missing (a restore from an older backup), so counting never stops. A
-- migration that rebuilds release, artist_image, genre or
-- genre_extra_parent must recreate these triggers.

INSERT OR IGNORE INTO app_setting (key, value) VALUES
    ('covers_version', '0'),
    ('pictures_version', '0'),
    ('genres_version', '0');

-- Covers: a release gaining, changing or losing its art.
CREATE TRIGGER covers_version_insert AFTER INSERT ON release WHEN NEW.art_key IS NOT NULL
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('covers_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER covers_version_update AFTER UPDATE OF art_key ON release WHEN OLD.art_key IS NOT NEW.art_key
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('covers_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER covers_version_delete AFTER DELETE ON release WHEN OLD.art_key IS NOT NULL
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('covers_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;

-- Artist pictures: added, hidden or shown, reordered, removed.
CREATE TRIGGER pictures_version_insert AFTER INSERT ON artist_image
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('pictures_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER pictures_version_update AFTER UPDATE ON artist_image
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('pictures_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER pictures_version_delete AFTER DELETE ON artist_image
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('pictures_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;

-- The genre tree: a genre added, renamed, moved or removed, and further parents.
CREATE TRIGGER genres_version_insert AFTER INSERT ON genre
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER genres_version_update AFTER UPDATE ON genre
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER genres_version_delete AFTER DELETE ON genre
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER genres_version_parent_insert AFTER INSERT ON genre_extra_parent
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER genres_version_parent_update AFTER UPDATE ON genre_extra_parent
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER genres_version_parent_delete AFTER DELETE ON genre_extra_parent
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('genres_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
