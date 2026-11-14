-- Migration 0065: an album's score leaves out its odd songs out, high or
-- low, instead of always its lowest.
--
-- Leaving out the lowest track always (0057) flattered a weak album: on
-- Confessions of a Dangerous Mind it dropped one of five bad songs, and on
-- Bobby Tarantino III it dropped the one bad song but kept the one good
-- one. Cillian's rule (14 Nov 2026): a song is an outlier when it is far
-- from the rest, and alone, or nearly. Far: 20 points (two gut steps) or
-- more from the album's middle song (its median). Nearly alone: the songs
-- that far out on its side are under 15% of the songs rated (of their
-- running time; of their number when a length is unknown). Then they are
-- left out. More than that, and they are what the album is like, and all
-- count. Each side is judged on its own: one lone bad song and one lone
-- great song can both be left out. Measured against the rated songs, not
-- the whole album (as 0057 did): those are what the score is made of, and
-- four bad songs of sixteen rated on a 25-track compilation are a quarter
-- of it, not a sixth.
--
-- The switch is still w_trim_lowest (on by default); off, every rated song
-- counts. src/lib/scoring.ts makes the same choice (outlierSides), and its
-- parity test holds the two together.

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
        count(r.length_ms) OVER grp AS n_timed,
        sum(r.length_ms) OVER grp AS rated_ms,
        avg(r.length_ms) OVER grp AS mean_length,
        row_number() OVER (PARTITION BY ct.release_group_id, s.user_id ORDER BY s.quality_score, ct.recording_id) AS from_lowest
    FROM canonical_tracks ct
    JOIN v_recording_score s ON s.recording_id = ct.recording_id
    JOIN recording r ON r.id = ct.recording_id
    LEFT JOIN recording_kind k ON k.recording_id = ct.recording_id
    JOIN v_active_weights w ON w.user_id = s.user_id
    WINDOW grp AS (PARTITION BY ct.release_group_id, s.user_id)
),
-- Each album's middle song: the median of its rated songs.
middle AS (
    SELECT release_group_id, user_id, avg(q) AS median
    FROM rated
    WHERE from_lowest IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY release_group_id, user_id
),
placed AS (
    SELECT
        rated.*,
        CASE WHEN rated.q <= m.median - 20 THEN 'low'
             WHEN rated.q >= m.median + 20 THEN 'high' END AS side
    FROM rated JOIN middle m ON m.release_group_id = rated.release_group_id AND m.user_id = rated.user_id
),
-- The sides whose far-out songs are few enough to be outliers.
outlying AS (
    SELECT release_group_id, user_id, side
    FROM placed p
    WHERE side IS NOT NULL AND trim_lowest
    GROUP BY release_group_id, user_id, side
    HAVING CASE WHEN max(n_timed) = max(n)
                THEN sum(length_ms) < 0.15 * max(rated_ms)
                ELSE count(*) < 0.15 * max(n)
           END
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
    FROM placed
    WHERE side IS NULL
       OR NOT EXISTS (SELECT 1 FROM outlying o
                      WHERE o.release_group_id = placed.release_group_id AND o.user_id = placed.user_id AND o.side = placed.side)
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
