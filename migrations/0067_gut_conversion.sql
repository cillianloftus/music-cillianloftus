-- Migration 0067: a gut score converts by the song's artist and genres,
-- not only by one number for the whole library.
--
-- Until now every gut-only rating became 10 × (gut + offset), the offset
-- the mean gap between gut and detailed scores over every rating row with
-- both. Cillian (14 Nov 2026): it should know the artist and the genres.
-- The conversion is now worked out in layers (src/lib/scoring.ts,
-- calibrate): the general gap, by gut level, then the artist's own gap,
-- then the genres' for what the artist leaves, each counting by how many
-- songs rated both ways it rests on (the weight calibration.evidence).
--
-- Worked out in the Worker, not here: the genre and artist gaps need a
-- song's genres, which no view can join without building v_recording_genre
-- whole, and D1 refuses score views nested much deeper than these. So each
-- gut-only song's conversion is kept in gut_conversion
-- (src/lib/gut-calibration.ts rebuilds it a minute after a rating, each
-- night, and when the weights change), and v_recording_score adds it; a
-- song not there yet uses the general gap. A cache of a parameter, not of
-- a score: the score is still worked out when read. Left out of backups.
--
-- The general gap now counts each song once, by its latest row with both
-- (ties by id): a song re-rated five times, or saved twice by the autosave
-- bug fixed on 14 Nov, counted five or two times.

CREATE TABLE gut_conversion (
    user_id       TEXT NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    recording_id  TEXT NOT NULL,
    -- Added to the gut score (0–10 scale): score = 10 × (gut + gut_offset).
    gut_offset    REAL NOT NULL,
    PRIMARY KEY (user_id, recording_id)
);

DROP VIEW v_recording_score;
DROP VIEW v_gut_calibration;

CREATE VIEW v_gut_calibration AS
SELECT
    u.id AS user_id,
    coalesce(avg(p.gap), 0) AS gut_offset,
    count(p.gap) AS sample_size
FROM app_user u
LEFT JOIN (
    SELECT a.user_id,
           a.craft_composite - a.gut_score AS gap,
           row_number() OVER (PARTITION BY a.user_id, a.entity_id ORDER BY a.rated_at DESC, a.rating_id DESC) AS newest
    FROM v_rating_axes a
    WHERE a.entity_type = 'recording'
      AND a.gut_score IS NOT NULL
      AND a.craft_composite IS NOT NULL
) p ON p.user_id = u.id AND p.newest = 1
GROUP BY u.id;

CREATE VIEW v_recording_score AS
SELECT
    a.entity_id AS recording_id,
    a.user_id,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + coalesce(g.gut_offset, c.gut_offset))))
        AS quality_score,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + coalesce(g.gut_offset, c.gut_offset))))
        + coalesce(a.impact, 0)
        AS personal_score,
    a.depth
FROM v_latest_rating_axes a
JOIN v_gut_calibration c ON c.user_id = a.user_id
LEFT JOIN gut_conversion g ON g.user_id = a.user_id AND g.recording_id = a.entity_id
WHERE a.entity_type = 'recording'
  AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = a.entity_id AND k.kind = 'skit');
