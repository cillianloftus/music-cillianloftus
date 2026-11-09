-- Migration 0057: the lowest-rated track is left out of an album's score
-- only when it is a small part of the album.
--
-- Leaving out the worst track judges an album by what it does well, which
-- is right for an hour-long record, where one weak three-minute song is 5%
-- of it. On a two-song single or a short EP it is half or a third of the
-- record, and leaving it out scored the release on its best song alone
-- (SCRAPYARD I read 95 where 93 is fair). Now the lowest track is left out
-- only when it is under 15% of the standard edition's running time (when
-- its length is unknown, under 15% of its tracks): a four-minute song is
-- left out of a 40-minute album, not of a 15-minute EP.
--
-- src/lib/scoring.ts makes the same choice (TRIM_MAX_SHARE), and its parity
-- test holds the two together.

DROP VIEW v_release_score;

CREATE VIEW v_release_score AS
WITH
canonical_tracks AS (
    SELECT DISTINCT x.release_group_id, x.id AS release_id, t.recording_id
    FROM (SELECT DISTINCT entity_id AS recording_id FROM rating WHERE entity_type = 'recording') rr
    JOIN track t ON t.recording_id = rr.recording_id
    JOIN release x ON x.id = t.release_id
    JOIN v_release_group_canonical c ON c.release_group_id = x.release_group_id AND c.release_id = x.id
    WHERE NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = t.recording_id AND k.kind = 'skit')
),
rated AS (
    SELECT
        ct.release_group_id,
        ct.release_id,
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
    -- The lowest is left out when it is under 15% of the album: of its
    -- running time, or, its length unknown, of its tracks. Worked out only
    -- for each album's lowest track.
    WHERE NOT (trim_lowest AND n >= 2 AND from_lowest = 1
               AND CASE WHEN length_ms IS NOT NULL
                        THEN length_ms < 0.15 * (SELECT sum(r2.length_ms) FROM track t2 JOIN recording r2 ON r2.id = t2.recording_id
                                                 WHERE t2.release_id = rated.release_id)
                        ELSE 1.0 < 0.15 * (SELECT count(*) FROM track t2 WHERE t2.release_id = rated.release_id)
                   END)
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
