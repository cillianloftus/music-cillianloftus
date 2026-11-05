-- When an outside source was last asked about an entity, so a nightly
-- lookup does not ask about the same track every night. Not provenance:
-- what a lookup added is recorded on the rows it added.
CREATE TABLE lookup_log (
    source     TEXT NOT NULL CHECK (source IN ('genius', 'musicbrainz', 'spotify')),
    entity_id  TEXT NOT NULL,
    found      INTEGER NOT NULL CHECK (found IN (0, 1)),
    looked_at  TEXT NOT NULL DEFAULT (datetime('now')),

    PRIMARY KEY (source, entity_id)
) STRICT;
