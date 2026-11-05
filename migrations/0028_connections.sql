-- Migration number: 0028
--
-- Connections to outside services that need a key (Last.fm, ListenBrainz,
-- Discogs, setlist.fm). A key can come from a Worker secret or be pasted on
-- /manage/connections; pasted ones live here. Backups leave this table out,
-- as they do Spotify tokens: they are secrets, and pasting again is easy.
CREATE TABLE connection_secret (
    service     TEXT NOT NULL,
    field       TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (service, field)
) STRICT;

-- How each connection last went: checked when a key is saved, and after
-- every sync, so the page can say "Connected as cillian" or "Key rejected".
-- cursor is where an incremental sync got to (a timestamp, for scrobbles).
CREATE TABLE connection_state (
    service     TEXT PRIMARY KEY NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
    detail      TEXT,
    checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    cursor      TEXT,
    synced_at   TEXT
) STRICT;

-- Plays can now come from ListenBrainz too. The play table is rebuilt to
-- widen its source check; nothing else refers to it.
CREATE TABLE play_new (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES app_user (id),
    recording_id  TEXT NOT NULL REFERENCES recording (id),
    played_at     TEXT NOT NULL,
    ms_played     INTEGER NOT NULL CHECK (ms_played >= 0),
    source        TEXT NOT NULL CHECK (source IN ('spotify_export', 'lastfm', 'listenbrainz', 'manual')),
    UNIQUE (user_id, recording_id, played_at, source)
) STRICT;

INSERT INTO play_new (id, user_id, recording_id, played_at, ms_played, source)
SELECT id, user_id, recording_id, played_at, ms_played, source FROM play;

DROP TABLE play;
ALTER TABLE play_new RENAME TO play;

CREATE INDEX play_recording ON play (recording_id, user_id);
CREATE INDEX play_played_at ON play (user_id, played_at);

-- Discogs joins the sources whose lookups are remembered.
CREATE TABLE lookup_log_new (
    source     TEXT NOT NULL CHECK (source IN ('genius', 'musicbrainz', 'spotify', 'deezer', 'itunes', 'wikipedia', 'discogs')),
    entity_id  TEXT NOT NULL,
    found      INTEGER NOT NULL CHECK (found IN (0, 1)),
    looked_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source, entity_id)
) STRICT;
INSERT INTO lookup_log_new SELECT source, entity_id, found, looked_at FROM lookup_log;
DROP TABLE lookup_log;
ALTER TABLE lookup_log_new RENAME TO lookup_log;
