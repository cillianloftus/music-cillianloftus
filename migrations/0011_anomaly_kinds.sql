-- Migration number: 0011
--
-- Review queue rules (ARCHITECTURE.md §3, "Review queue"). Adds one kind:
-- near_duplicate_release_group, two albums by the same artist whose titles
-- match once edition words are stripped. That is how a deluxe edition filed
-- as a separate album shows up, which track counts within one group cannot
-- see. SQLite cannot alter a CHECK, so the table is rebuilt; it is new and
-- holds nothing a rule cannot raise again.

CREATE TABLE anomaly_new (
    id           TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL
                 CHECK (kind IN ('duplicate_artist_name', 'near_duplicate_recording',
                                 'near_duplicate_release_group',
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

INSERT INTO anomaly_new SELECT * FROM anomaly;
DROP TABLE anomaly;
ALTER TABLE anomaly_new RENAME TO anomaly;

CREATE UNIQUE INDEX anomaly_open_once
    ON anomaly (kind, entity_type, entity_a, coalesce(entity_b, ''))
    WHERE status = 'open';
