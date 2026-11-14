-- Migration 0068: the gut calibration learns only from a song's current
-- rating, and not from slips.
--
-- 0067 paired each song's latest row with both a gut and a detailed score.
-- On 14 Nov a Bread Song rating was autosaved mid-change (gut 10, detailed
-- 0), then given again by gut alone seven seconds later; the stray row
-- still counted, and took two points off every Black Country, New Road
-- gut 10. Now a song counts only when its current rating has both, and
-- only when they are within 3 points of each other (src/lib/scoring.ts,
-- pairsOf and MAX_PAIR_GAP, which this must match).

DROP VIEW v_gut_calibration;

CREATE VIEW v_gut_calibration AS
SELECT
    u.id AS user_id,
    coalesce(avg(p.gap), 0) AS gut_offset,
    count(p.gap) AS sample_size
FROM app_user u
LEFT JOIN (
    SELECT a.user_id,
           a.gut_score,
           a.craft_composite,
           a.craft_composite - a.gut_score AS gap,
           row_number() OVER (PARTITION BY a.user_id, a.entity_id ORDER BY a.rated_at DESC, a.rating_id DESC) AS newest
    FROM v_rating_axes a
    WHERE a.entity_type = 'recording'
) p ON p.user_id = u.id
   AND p.newest = 1
   AND p.gut_score IS NOT NULL
   AND p.craft_composite IS NOT NULL
   AND abs(p.gap) <= 3
GROUP BY u.id;
