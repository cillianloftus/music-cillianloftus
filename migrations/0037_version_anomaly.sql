-- Migration number: 0037
--
-- Review: another version of a song. A remix, a sped-up or acoustic take,
-- a live cut: a different recording of the same song by the same artist,
-- found by its title once the version words are set aside ("Song (Kaytranada
-- Remix)" beside "Song"). Linked, the two share a work, so they show as
-- versions of one track and collapse into one song in playlists.
-- entity_a is the song as first released, entity_b the version.
-- SQLite cannot alter a CHECK, so the table is rebuilt as in 0011.

CREATE TABLE anomaly_new (
    id           TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL
                 CHECK (kind IN ('duplicate_artist_name', 'near_duplicate_recording',
                                 'near_duplicate_release_group', 'version_of_recording',
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
    skipped_at   TEXT,

    CHECK ((status = 'open') = (resolution IS NULL))
) STRICT;

INSERT INTO anomaly_new (id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution, skipped_at)
SELECT id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution, skipped_at FROM anomaly;
DROP TABLE anomaly;
ALTER TABLE anomaly_new RENAME TO anomaly;

CREATE UNIQUE INDEX anomaly_open_once
    ON anomaly (kind, entity_type, entity_a, coalesce(entity_b, ''))
    WHERE status = 'open';
