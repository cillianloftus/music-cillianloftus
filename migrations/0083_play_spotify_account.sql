-- A source for Spotify's Account Data export (StreamingHistory_music_*.json):
-- the last year, each listen as artist, title, its end to the minute and
-- how long it played, with no track id (19 Nov 2026: 28,081 listens).
-- Kept apart from 'spotify_export' (the extended history, with ids), as
-- the two cover the same streams: listens of one source are never paired
-- as copies (listens/dedupe.ts), so under one name every listen of a year
-- covered by both would count twice. Ranked just under it.
--
-- SQLite cannot change a CHECK in place: the table is made again as 0041
-- made it, with the one list longer.
PRAGMA defer_foreign_keys = true;

CREATE TABLE play_new (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES app_user (id),
    track_key     TEXT NOT NULL REFERENCES listen_track (key),
    -- The listen_track's recording, copied so play counts stay one lookup.
    recording_id  TEXT REFERENCES recording (id),
    -- When listening started, UTC. Spotify's exports stamp the end; the
    -- importer subtracts ms_played.
    played_at     TEXT NOT NULL,
    -- Null when the source does not say (Last.fm).
    ms_played     INTEGER CHECK (ms_played >= 0),
    source        TEXT NOT NULL CHECK (source IN ('spotify_export', 'spotify_account', 'lastfm', 'listenbrainz', 'manual')),
    counted       INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1)),
    duplicate_of  TEXT REFERENCES play_new (id) ON DELETE SET NULL,
    -- As the source gives them; null when it does not.
    skipped       INTEGER CHECK (skipped IN (0, 1)),
    shuffle       INTEGER CHECK (shuffle IN (0, 1)),
    offline       INTEGER CHECK (offline IN (0, 1)),
    incognito     INTEGER CHECK (incognito IN (0, 1)),
    -- Spotify: platform ("android", "windows"...); ListenBrainz: the player.
    platform      TEXT,
    country       TEXT,
    reason_start  TEXT,
    reason_end    TEXT,
    UNIQUE (user_id, track_key, played_at, source)
) STRICT;

INSERT INTO play_new
SELECT id, user_id, track_key, recording_id, played_at, ms_played, source, counted, duplicate_of,
       skipped, shuffle, offline, incognito, platform, country, reason_start, reason_end
FROM play;

DROP TABLE play;
ALTER TABLE play_new RENAME TO play;

CREATE INDEX play_recording ON play (recording_id, user_id);
CREATE INDEX play_played_at ON play (user_id, played_at);
-- A listen_track matched later points its plays at the recording by key.
CREATE INDEX play_track ON play (track_key);
