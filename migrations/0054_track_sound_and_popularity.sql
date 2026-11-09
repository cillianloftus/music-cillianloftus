-- Migration 0054: each track's tempo and loudness, and how widely it is heard.
--
-- From Deezer (free, no key), matched through its album's tracklist by
-- disc, position and title, or by ISRC: tempo in beats per minute and
-- loudness (Deezer's replay gain, in dB: how far a player turns it down to
-- a common level, so the more negative, the louder it was mastered),
-- whether it is marked explicit, and Deezer's own popularity
-- rank. Spotify closed its audio features to new apps in 2024, so this is
-- the open source of them. A missing ISRC is filled from the match too.
--
-- From ListenBrainz, by MusicBrainz id: how many times everyone there has
-- listened to it, and how many people have. Looked at again each month.
--
-- Fill only: each value is set when missing and never over a hand edit.

ALTER TABLE recording ADD COLUMN bpm REAL CHECK (bpm IS NULL OR bpm > 0);
ALTER TABLE recording ADD COLUMN loudness REAL;
ALTER TABLE recording ADD COLUMN explicit INTEGER CHECK (explicit IS NULL OR explicit IN (0, 1));
ALTER TABLE recording ADD COLUMN deezer_id INTEGER;
ALTER TABLE recording ADD COLUMN deezer_rank INTEGER;
ALTER TABLE recording ADD COLUMN listen_count INTEGER CHECK (listen_count IS NULL OR listen_count >= 0);
ALTER TABLE recording ADD COLUMN listener_count INTEGER CHECK (listener_count IS NULL OR listener_count >= 0);

-- Lookups remembered for these and for the sources coming next (labels and
-- series from MusicBrainz, Wikidata, Discogs releases, Last.fm tags), so
-- each does not need the table rebuilt again.
CREATE TABLE lookup_log_new (
    source     TEXT NOT NULL CHECK (source IN (
        'genius', 'genius-links', 'musicbrainz', 'musicbrainz-more', 'spotify', 'deezer', 'deezer-tracks',
        'itunes', 'wikipedia', 'wikidata', 'discogs', 'discogs-release', 'listenbrainz', 'lastfm')),
    entity_id  TEXT NOT NULL,
    found      INTEGER NOT NULL CHECK (found IN (0, 1)),
    looked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, entity_id)
) STRICT;
INSERT INTO lookup_log_new SELECT source, entity_id, found, looked_at FROM lookup_log;
DROP TABLE lookup_log;
ALTER TABLE lookup_log_new RENAME TO lookup_log;

-- What track pages show changed in place. Not the listen counts: they move
-- a little every month, and pages are kept only fifteen minutes anyway.
CREATE TRIGGER library_version_recording_sound
AFTER UPDATE OF bpm, loudness, explicit ON recording
WHEN OLD.bpm IS NOT NEW.bpm OR OLD.loudness IS NOT NEW.loudness OR OLD.explicit IS NOT NEW.explicit
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('library_version', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;
