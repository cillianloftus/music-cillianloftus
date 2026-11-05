-- Migration number: 0014
--
-- An axis can be marked as not applying (an instrumental has no lyrics),
-- which is different from not having rated it yet. Either way the axis is
-- NULL and left out of the composite; this records which it was, so the
-- rating says "Lyrics: n/a" and the next rating of the track starts there.
--
-- A JSON array of axis names, NULL when none.

ALTER TABLE rating ADD COLUMN not_applicable TEXT
    CHECK (not_applicable IS NULL OR (json_valid(not_applicable) AND json_type(not_applicable) = 'array'));

-- Append-only covers the new column too.
DROP TRIGGER rating_no_update;

CREATE TRIGGER rating_no_update
BEFORE UPDATE OF id, user_id, entity_type, rated_at, depth, gut_score,
                 production, songwriting, lyrics, performance,
                 sequencing, cohesion, ambition, impact, impact_note, not_applicable
ON rating
BEGIN
    SELECT RAISE(ABORT, 'rating rows are append-only');
END;
