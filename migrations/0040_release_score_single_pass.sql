-- v_release_score again: 0039 made it shallower, but production D1 still
-- refused it beside v_release_group_canonical in one query (every album
-- list). D1's "VIEWs and/or subqueries nested too deep" counts each
-- expansion, and a CTE named twice is expanded twice: 0039's union of the
-- track and album parts, then joining both back, pulled v_recording_score
-- and everything under it in two or three times. Here each part is read
-- once (UNION ALL, then grouped), and the track count asks the canonical
-- edition directly. Checked equal to 0034's on all 53 scored albums, and
-- run on production inside three more subqueries and beside two more
-- canonical-edition joins. Local SQLite has no such cap: test new views
-- against production (read-only) before shipping them.

DROP VIEW v_release_score;

CREATE VIEW v_release_score AS
WITH
canonical_tracks AS (
    SELECT DISTINCT c.release_group_id, t.recording_id
    FROM v_release_group_canonical c
    JOIN track t ON t.release_id = c.release_id
    WHERE NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = t.recording_id AND k.kind = 'skit')
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
),
parts AS (
    SELECT release_group_id, user_id, n, tracks_score, NULL AS album_score, NULL AS impact, NULL AS track_count FROM track_part
    UNION ALL
    SELECT release_group_id, user_id, NULL, NULL, score, impact, NULL FROM album_part
)
SELECT
    p.release_group_id,
    p.user_id,
    max(0.0, min(100.0,
            CASE
                WHEN max(tracks_score) IS NOT NULL AND max(album_score) IS NOT NULL
                    THEN (w.w_tracks * max(tracks_score) + w.w_album_axes * max(album_score)) / (w.w_tracks + w.w_album_axes)
                ELSE coalesce(max(tracks_score), max(album_score))
            END)) AS quality_score,
    max(0.0, min(100.0,
            CASE
                WHEN max(tracks_score) IS NOT NULL AND max(album_score) IS NOT NULL
                    THEN (w.w_tracks * max(tracks_score) + w.w_album_axes * max(album_score)) / (w.w_tracks + w.w_album_axes)
                ELSE coalesce(max(tracks_score), max(album_score))
            END)) + coalesce(max(p.impact), 0) AS personal_score,
    coalesce(max(p.n), 0) AS rated_track_count,
    (SELECT count(DISTINCT t.recording_id) FROM release_group g
       JOIN track t ON t.release_id = coalesce(g.preferred_release_id, (SELECT c.release_id FROM v_release_group_canonical c WHERE c.release_group_id = g.id))
       WHERE g.id = p.release_group_id
         AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = t.recording_id AND k.kind = 'skit')) AS track_count
FROM parts p
JOIN v_active_weights w ON w.user_id = p.user_id
GROUP BY p.release_group_id, p.user_id
HAVING coalesce(max(p.tracks_score), max(p.album_score)) IS NOT NULL;
