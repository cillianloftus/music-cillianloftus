-- Migration number: 0010
--
-- A rating can become unscorable under some weights: a track rated only on
-- lyrics, with no gut score, has no score once lyrics is weighted zero.
-- 0003 let such rows through with a NULL score, and the album average then
-- counted them in its denominator, dragging the album down. Unscorable rows
-- now drop out instead, exactly as if the rating were absent.
--
-- Found by the weights preview's parity test (src/lib/scoring.test.ts).

DROP VIEW v_recording_score;

CREATE VIEW v_recording_score AS
SELECT
    a.entity_id AS recording_id,
    a.user_id,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + c.gut_offset)))
        AS quality_score,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + c.gut_offset)))
        + coalesce(a.impact, 0)
        AS personal_score,
    a.depth
FROM v_latest_rating_axes a
JOIN v_gut_calibration c ON c.user_id = a.user_id
WHERE a.entity_type = 'recording'
  AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL;


DROP VIEW v_release_score;

CREATE VIEW v_release_score AS
WITH
canonical_tracks AS (
    SELECT DISTINCT c.release_group_id, t.recording_id
    FROM v_release_group_canonical c
    JOIN track t ON t.release_id = c.release_id
),
track_part AS (
    SELECT
        ct.release_group_id,
        s.user_id,
        count(*) AS n,
        sum(s.quality_score) AS total,
        min(s.quality_score) AS lowest
    FROM canonical_tracks ct
    JOIN v_recording_score s ON s.recording_id = ct.recording_id
    GROUP BY ct.release_group_id, s.user_id
),
album_part AS (
    SELECT
        a.entity_id AS release_group_id,
        a.user_id,
        10.0 * coalesce(a.album_composite, a.gut_score + c.gut_offset) AS score,
        a.impact
    FROM v_latest_rating_axes a
    JOIN v_gut_calibration c ON c.user_id = a.user_id
    WHERE a.entity_type = 'release_group'
),
pairs AS (
    SELECT release_group_id, user_id FROM track_part
    UNION
    SELECT release_group_id, user_id FROM album_part
),
parts AS (
    SELECT
        p.release_group_id,
        p.user_id,
        CASE
            WHEN tp.n >= 2 AND w.trim_lowest THEN (tp.total - tp.lowest) / (tp.n - 1)
            ELSE tp.total / tp.n
        END AS tracks_score,
        ap.score AS album_score,
        ap.impact,
        w.w_tracks,
        w.w_album_axes,
        coalesce(tp.n, 0) AS rated_track_count
    FROM pairs p
    JOIN v_active_weights w ON w.user_id = p.user_id
    LEFT JOIN track_part tp ON tp.release_group_id = p.release_group_id AND tp.user_id = p.user_id
    LEFT JOIN album_part ap ON ap.release_group_id = p.release_group_id AND ap.user_id = p.user_id
),
blended AS (
    SELECT
        release_group_id,
        user_id,
        max(0.0, min(100.0,
            CASE
                WHEN tracks_score IS NOT NULL AND album_score IS NOT NULL
                    THEN (w_tracks * tracks_score + w_album_axes * album_score)
                         / (w_tracks + w_album_axes)
                ELSE coalesce(tracks_score, album_score)
            END)) AS quality_score,
        impact,
        rated_track_count
    FROM parts
)
SELECT
    b.release_group_id,
    b.user_id,
    b.quality_score,
    b.quality_score + coalesce(b.impact, 0) AS personal_score,
    b.rated_track_count,
    (SELECT count(*) FROM canonical_tracks ct WHERE ct.release_group_id = b.release_group_id)
        AS track_count
FROM blended b
WHERE b.quality_score IS NOT NULL;
