-- Every listen, for recaps (ARCHITECTURE.md "As built: listens and recaps").
--
-- Until now only plays of catalogued recordings were kept, and anything
-- else in an export or a scrobble feed was thrown away; a recap would have
-- undercounted. Now every listen is kept against a listen_track: the track
-- as the source named it. A listen_track is matched to a recording when the
-- catalogue has it, now or after a later import, and its plays follow.
--
-- The same moment of listening can arrive from more than one source (the
-- Spotify export and Last.fm scrobbles of the same stream). Each copy is
-- kept, with what its source knew, but only one counts: the others name it
-- in duplicate_of. See src/lib/listens/dedupe.ts for the exact rule.
--
-- `counted` is what every play count reads: 1 for a listen of 30 seconds or
-- more (or of unknown length, as scrobbles are) that is no other listen's
-- duplicate. Shorter streams are kept for skip statistics but never count.
--
-- The play table had no rows in production when this ran; existing rows
-- (in local copies) are carried over against a listen_track per recording.

CREATE TABLE listen_track (
    -- 'spotify:<id>', 'mbid:<recording mbid>', or 'name:<artist_key>|<title_key>'.
    key           TEXT PRIMARY KEY NOT NULL,
    artist        TEXT NOT NULL,
    title         TEXT NOT NULL,
    album         TEXT,
    -- normaliseName(first credited artist) and normaliseTitle(title): one
    -- song across sources, whatever each calls it.
    artist_key    TEXT NOT NULL,
    title_key     TEXT NOT NULL,
    spotify_id    TEXT,
    mbid          TEXT,
    recording_id  TEXT REFERENCES recording (id) ON DELETE SET NULL,
    matched_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX listen_track_song ON listen_track (artist_key, title_key);
CREATE INDEX listen_track_recording ON listen_track (recording_id);

INSERT INTO listen_track (key, artist, title, artist_key, title_key, recording_id, matched_at)
SELECT DISTINCT 'recording:' || r.id,
       coalesce((SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                 WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'
                 ORDER BY c.position LIMIT 1), ''),
       r.title,
       lower(coalesce((SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                       WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'
                       ORDER BY c.position LIMIT 1), '')),
       lower(r.title),
       r.id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM play p JOIN recording r ON r.id = p.recording_id;

CREATE TABLE play_new (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES app_user (id),
    track_key     TEXT NOT NULL REFERENCES listen_track (key),
    -- The listen_track's recording, copied so play counts stay one lookup.
    recording_id  TEXT REFERENCES recording (id),
    -- When listening started, UTC. Spotify's export stamps the end; the
    -- importer subtracts ms_played.
    played_at     TEXT NOT NULL,
    -- Null when the source does not say (Last.fm).
    ms_played     INTEGER CHECK (ms_played >= 0),
    source        TEXT NOT NULL CHECK (source IN ('spotify_export', 'lastfm', 'listenbrainz', 'manual')),
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

INSERT INTO play_new (id, user_id, track_key, recording_id, played_at, ms_played, source, counted)
SELECT id, user_id, 'recording:' || recording_id, recording_id, played_at, ms_played, source,
       CASE WHEN ms_played = 0 OR ms_played >= 30000 THEN 1 ELSE 0 END
FROM play;

DROP TABLE play;
ALTER TABLE play_new RENAME TO play;

CREATE INDEX play_recording ON play (recording_id, user_id);
CREATE INDEX play_played_at ON play (user_id, played_at);
-- A listen_track matched later points its plays at the recording by key.
CREATE INDEX play_track ON play (track_key);
