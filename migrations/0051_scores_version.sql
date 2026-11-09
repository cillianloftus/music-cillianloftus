-- Migration 0051: a version number for what moves scores without a rating.
--
-- Album scores are now kept per user until the library changes
-- (src/lib/album-scores.ts), so the cache stamps must move whenever a score
-- can: ratings do (they are append-only, stamped by rowid), and so do a new
-- weighting and a track's kind (a skit leaves the album's score, an
-- interlude counts for less), which change rows in place. Like 0049, a
-- trigger bumps a number in app_setting; a migration that rebuilds weights
-- or recording_kind must recreate these.

INSERT OR IGNORE INTO app_setting (key, value) VALUES ('scores_version', '0');

CREATE TRIGGER scores_version_weights_insert AFTER INSERT ON weights
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('scores_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER scores_version_weights_update AFTER UPDATE ON weights
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('scores_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER scores_version_kind_insert AFTER INSERT ON recording_kind
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('scores_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER scores_version_kind_update AFTER UPDATE ON recording_kind
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('scores_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
CREATE TRIGGER scores_version_kind_delete AFTER DELETE ON recording_kind
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('scores_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
