-- Migration 0058: review older ratings.
--
-- Track ratings made before arrangement and sound were split (0042) keep
-- one production score, which the score views read as both; those made
-- before originality (0045) have none. A detailed rating like that is
-- raised for review (`outdated_rating`, entity_a the recording) so it can
-- be rated again with every axis; it clears itself once the latest rating
-- has them (src/lib/review.ts). The table is rebuilt as in 0037: SQLite
-- cannot alter a CHECK.

CREATE TABLE anomaly_new (
    id           TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL
                 CHECK (kind IN ('duplicate_artist_name', 'near_duplicate_recording',
                                 'near_duplicate_release_group', 'version_of_recording',
                                 'track_count_mismatch', 'unlinked_rated_recording',
                                 'missing_cover_art', 'orphaned_track', 'import_match',
                                 'outdated_rating')),
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
