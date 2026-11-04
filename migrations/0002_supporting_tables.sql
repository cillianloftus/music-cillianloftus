-- Migration number: 0002
--
-- Everything in ARCHITECTURE.md §3 that is not catalogue, credits, genre or
-- ratings: provenance, the review queue, jobs, Spotify tokens, ownership,
-- listening history and playlist definitions.
--
-- Same conventions as 0001.


-- ---------------------------------------------------------------------------
-- Provenance and corrections
-- ---------------------------------------------------------------------------

-- One current override per field. Reads merge these over the base row;
-- imports never touch this table. Reverting a correction deletes its row.
CREATE TABLE field_override (
    entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('artist', 'work', 'recording', 'release_group',
                                        'release', 'track', 'genre')),
    entity_id    TEXT NOT NULL,
    field        TEXT NOT NULL CHECK (field <> ''),
    value_json   TEXT NOT NULL CHECK (json_valid(value_json)),
    user_id      TEXT NOT NULL REFERENCES app_user (id),
    edited_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    PRIMARY KEY (entity_type, entity_id, field)
) STRICT;


-- ---------------------------------------------------------------------------
-- Review queue
-- ---------------------------------------------------------------------------

-- Raised by scheduled rules. Rules never fix anything themselves.
CREATE TABLE anomaly (
    id           TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL
                 CHECK (kind IN ('duplicate_artist_name', 'near_duplicate_recording',
                                 'track_count_mismatch', 'unlinked_rated_recording',
                                 'missing_cover_art', 'orphaned_track', 'import_match')),
    entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('artist', 'work', 'recording', 'release_group',
                                        'release', 'track', 'genre')),
    entity_a     TEXT NOT NULL,
    entity_b     TEXT,
    detected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved', 'dismissed')),
    resolution   TEXT,

    CHECK ((status = 'open') = (resolution IS NULL))
) STRICT;

-- A rule must not raise the same open anomaly twice.
CREATE UNIQUE INDEX anomaly_open_once
    ON anomaly (kind, entity_type, entity_a, coalesce(entity_b, ''))
    WHERE status = 'open';


-- Written by a merge so old ids keep resolving. Nothing is deleted.
CREATE TABLE entity_redirect (
    entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('artist', 'work', 'recording', 'release_group',
                                        'release', 'track', 'genre')),
    old_id       TEXT NOT NULL,
    new_id       TEXT NOT NULL,

    PRIMARY KEY (entity_type, old_id),
    CHECK (old_id <> new_id)
) STRICT;

CREATE INDEX entity_redirect_new ON entity_redirect (entity_type, new_id);


-- Pairs judged distinct, so the same pair is never raised again. Stored in
-- canonical order (id_a < id_b) so each pair has exactly one row.
CREATE TABLE confirmed_distinct (
    entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('artist', 'work', 'recording', 'release_group',
                                        'release', 'track', 'genre')),
    id_a         TEXT NOT NULL,
    id_b         TEXT NOT NULL,

    PRIMARY KEY (entity_type, id_a, id_b),
    CHECK (id_a < id_b)
) STRICT;


-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

CREATE TABLE job (
    id            TEXT PRIMARY KEY NOT NULL,
    kind          TEXT NOT NULL
                  CHECK (kind IN ('import_release', 'import_discography', 'derive_genres',
                                  'backup', 'recompute_calibration', 'spotify_push',
                                  'generate_art')),
    payload_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed')),
    progress      INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0),
    total         INTEGER CHECK (total >= 0),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    started_at    TEXT,
    finished_at   TEXT,
    error         TEXT,

    CHECK (status <> 'failed' OR error IS NOT NULL)
) STRICT;

CREATE INDEX job_queue ON job (status, created_at);


-- ---------------------------------------------------------------------------
-- Spotify
-- ---------------------------------------------------------------------------

CREATE TABLE spotify_token (
    user_id        TEXT PRIMARY KEY NOT NULL REFERENCES app_user (id),
    refresh_token  TEXT NOT NULL,
    access_token   TEXT,
    expires_at     TEXT,
    -- Drives the six-month re-authorisation warning.
    authorized_at  TEXT NOT NULL
) STRICT;


-- ---------------------------------------------------------------------------
-- Ownership and files
-- ---------------------------------------------------------------------------

CREATE TABLE holding (
    id              TEXT PRIMARY KEY NOT NULL,
    user_id         TEXT NOT NULL REFERENCES app_user (id),
    release_id      TEXT NOT NULL REFERENCES release (id),
    format          TEXT NOT NULL CHECK (format IN ('cd', 'vinyl', 'cassette', 'digital')),
    acquired_at     TEXT,
    date_precision  TEXT NOT NULL DEFAULT 'unknown',
    notes           TEXT,

    CHECK (
        (date_precision = 'unknown' AND acquired_at IS NULL) OR
        (date_precision = 'year'    AND acquired_at GLOB '[0-9][0-9][0-9][0-9]') OR
        (date_precision = 'month'   AND acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]') OR
        (date_precision = 'day'     AND acquired_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
                                    AND date(acquired_at) = acquired_at)
    )
) STRICT;

CREATE INDEX holding_user_release ON holding (user_id, release_id);


-- Audio already owned, catalogued by path. Never uploaded or served.
CREATE TABLE file (
    id            TEXT PRIMARY KEY NOT NULL,
    recording_id  TEXT NOT NULL REFERENCES recording (id),
    path          TEXT NOT NULL UNIQUE,
    format        TEXT NOT NULL,
    bitrate       INTEGER CHECK (bitrate > 0),
    checksum      TEXT
) STRICT;

CREATE INDEX file_recording ON file (recording_id);


-- ---------------------------------------------------------------------------
-- Listening history
-- ---------------------------------------------------------------------------

CREATE TABLE play (
    id            TEXT PRIMARY KEY NOT NULL,
    user_id       TEXT NOT NULL REFERENCES app_user (id),
    recording_id  TEXT NOT NULL REFERENCES recording (id),
    played_at     TEXT NOT NULL,
    ms_played     INTEGER NOT NULL CHECK (ms_played >= 0),
    source        TEXT NOT NULL CHECK (source IN ('spotify_export', 'lastfm', 'manual')),

    -- Re-importing an overlapping export must not double count.
    UNIQUE (user_id, recording_id, played_at, source)
) STRICT;

CREATE INDEX play_recording ON play (recording_id, user_id);
CREATE INDEX play_played_at ON play (user_id, played_at);


-- ---------------------------------------------------------------------------
-- Playlist definitions
-- ---------------------------------------------------------------------------

-- A saved query, not a list of tracks.
CREATE TABLE definition (
    id                   TEXT PRIMARY KEY NOT NULL,
    user_id              TEXT NOT NULL REFERENCES app_user (id),
    name                 TEXT NOT NULL CHECK (name <> ''),
    description          TEXT,
    query_json           TEXT NOT NULL CHECK (json_valid(query_json)),
    spotify_playlist_id  TEXT UNIQUE,
    art_key              TEXT,
    art_mode             TEXT NOT NULL DEFAULT 'generated'
                         CHECK (art_mode IN ('generated', 'uploaded')),
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX definition_user ON definition (user_id);


-- A snapshot of each generation, so drift is visible over time.
CREATE TABLE definition_run (
    id               TEXT PRIMARY KEY NOT NULL,
    definition_id    TEXT NOT NULL REFERENCES definition (id),
    ran_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    result_ids_json  TEXT NOT NULL CHECK (json_valid(result_ids_json)
                                          AND json_type(result_ids_json) = 'array')
) STRICT;

CREATE INDEX definition_run_definition ON definition_run (definition_id, ran_at);


CREATE TABLE definition_pin (
    definition_id  TEXT NOT NULL REFERENCES definition (id),
    recording_id   TEXT NOT NULL REFERENCES recording (id),

    PRIMARY KEY (definition_id, recording_id)
) STRICT;

CREATE TABLE definition_exclude (
    definition_id  TEXT NOT NULL REFERENCES definition (id),
    recording_id   TEXT NOT NULL REFERENCES recording (id),

    PRIMARY KEY (definition_id, recording_id)
) STRICT;
