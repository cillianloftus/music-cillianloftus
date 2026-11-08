-- v_release_score, flatter. Production D1 caps how deeply views, CTEs and
-- subqueries may nest, and 0034's view sat right at the cap: on its own it
-- ran, but any query using it inside a subquery failed with "VIEWs and/or
-- subqueries nested too deep" (home, artist and album pages, 8 Nov 2026).
-- Same scores, fewer layers: the weighting folds into the aggregate, the
-- blend into the final select, and the track count is joined, not a
-- correlated subquery. Checked equal to 0034's on all 53 scored albums.
-- Local SQLite does not enforce D1's cap, so tests cannot catch this; keep
-- new score views shallow.

DROP VIEW v_release_score;

CREATE VIEW v_release_score AS
WITH
canonical_tracks AS (
    SELECT DISTINCT c.release_group_id, t.recording_id
    FROM v_release_group_canonical c
    JOIN track t ON t.release_id = c.release_id
    WHERE NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = t.recording_id AND k.kind = 'skit')
),
counts AS (
    SELECT release_group_id, count(*) AS track_count FROM canonical_tracks GROUP BY release_group_id
),
rated AS (
    SELECT
        ct.release_group_id,
        s.user_id,
        s.quality_score AS q,
        r.length_ms,
        CASE WHEN k.kind = 'interlude' THEN w.w_interlude ELSE 1.0 END AS kind_weight,
        w.length_influence,
        w.trim_lowest,
        count(*) OVER grp AS n,
        avg(r.length_ms) OVER grp AS mean_length,
        row_number() OVER (PARTITION BY ct.release_group_id, s.user_id ORDER BY s.quality_score, ct.recording_id) AS from_lowest
    FROM canonical_tracks ct
    JOIN v_recording_score s ON s.recording_id = ct.recording_id
    JOIN recording r ON r.id = ct.recording_id
    LEFT JOIN recording_kind k ON k.recording_id = ct.recording_id
    JOIN v_active_weights w ON w.user_id = s.user_id
    WINDOW grp AS (PARTITION BY ct.release_group_id, s.user_id)
),
track_part AS (
    SELECT
        release_group_id,
        user_id,
        max(n) AS n,
        sum(kind_weight * CASE WHEN length_ms IS NULL OR mean_length IS NULL THEN 1.0
                               ELSE (1.0 - length_influence) + length_influence * length_ms / mean_length END * q)
        / nullif(sum(kind_weight * CASE WHEN length_ms IS NULL OR mean_length IS NULL THEN 1.0
                                        ELSE (1.0 - length_influence) + length_influence * length_ms / mean_length END), 0)
            AS tracks_score
    FROM rated
    WHERE NOT (trim_lowest AND n >= 2 AND from_lowest = 1)
    GROUP BY release_group_id, user_id
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
)
SELECT
    p.release_group_id,
    p.user_id,
    max(0.0, min(100.0,
            CASE
                WHEN tp.tracks_score IS NOT NULL AND ap.score IS NOT NULL
                    THEN (w.w_tracks * tp.tracks_score + w.w_album_axes * ap.score) / (w.w_tracks + w.w_album_axes)
                ELSE coalesce(tp.tracks_score, ap.score)
            END)) AS quality_score,
    max(0.0, min(100.0,
            CASE
                WHEN tp.tracks_score IS NOT NULL AND ap.score IS NOT NULL
                    THEN (w.w_tracks * tp.tracks_score + w.w_album_axes * ap.score) / (w.w_tracks + w.w_album_axes)
                ELSE coalesce(tp.tracks_score, ap.score)
            END)) + coalesce(ap.impact, 0) AS personal_score,
    coalesce(tp.n, 0) AS rated_track_count,
    coalesce(k.track_count, 0) AS track_count
FROM (SELECT release_group_id, user_id FROM track_part
      UNION
      SELECT release_group_id, user_id FROM album_part) p
JOIN v_active_weights w ON w.user_id = p.user_id
LEFT JOIN track_part tp ON tp.release_group_id = p.release_group_id AND tp.user_id = p.user_id
LEFT JOIN album_part ap ON ap.release_group_id = p.release_group_id AND ap.user_id = p.user_id
LEFT JOIN counts k ON k.release_group_id = p.release_group_id
WHERE coalesce(tp.tracks_score, ap.score) IS NOT NULL;
