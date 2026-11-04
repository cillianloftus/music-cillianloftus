-- Migration number: 0007
--
-- State for the rating queue (ARCHITECTURE.md §7).

-- A skip deprioritises an item; it never hides it. Repeated skips count.
CREATE TABLE queue_skip (
    user_id      TEXT NOT NULL REFERENCES app_user (id),
    entity_type  TEXT NOT NULL CHECK (entity_type IN ('recording', 'release_group')),
    entity_id    TEXT NOT NULL,
    skip_count   INTEGER NOT NULL DEFAULT 1 CHECK (skip_count >= 1),
    skipped_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    PRIMARY KEY (user_id, entity_type, entity_id)
) STRICT;


-- When something was last opened in Spotify from the queue. On returning,
-- it waits at the top until rated: the small piece of state that turns a
-- page into a loop.
CREATE TABLE queue_handoff (
    user_id      TEXT NOT NULL REFERENCES app_user (id),
    entity_type  TEXT NOT NULL CHECK (entity_type IN ('recording', 'release_group')),
    entity_id    TEXT NOT NULL,
    opened_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    PRIMARY KEY (user_id, entity_type, entity_id)
) STRICT;
