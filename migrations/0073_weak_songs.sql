-- Migration 0073: weak songs pull an album down harder.
--
-- An album's track part was a plain (length- and kind-weighted) mean, so a
-- bad album's few decent songs carried it: Confessions of a Dangerous Mind,
-- 7 of its 16 songs under 60, scored 55; Everybody, 7 of 12, scored 60.
-- Now a song under 70 counts for more the further under it is:
-- 1 + harshness × (70 − score) / 30, harshness the weight release.harshness
-- (2 when unset: a 40 counts three times, a 10 five times). Albums without
-- weak songs do not move. src/lib/scoring.ts (weakWeight) is the twin.

DROP VIEW v_release_score;
DROP VIEW v_active_weights;

CREATE VIEW v_active_weights AS
SELECT
    u.id AS user_id,
    coalesce(json_extract(w.payload_json, '$.craft.arrangement'),
             json_extract(w.payload_json, '$.craft.production') / 2.0, 0.5) AS w_arrangement,
    coalesce(json_extract(w.payload_json, '$.craft.sound'),
             json_extract(w.payload_json, '$.craft.production') / 2.0, 0.5) AS w_sound,
    coalesce(json_extract(w.payload_json, '$.craft.songwriting'), 1.0) AS w_songwriting,
    coalesce(json_extract(w.payload_json, '$.craft.lyrics'),      1.0) AS w_lyrics,
    coalesce(json_extract(w.payload_json, '$.craft.performance'), 1.0) AS w_performance,
    coalesce(json_extract(w.payload_json, '$.craft.originality'), 1.0) AS w_originality,
    coalesce(json_extract(w.payload_json, '$.album.sequencing'),  1.0) AS w_sequencing,
    coalesce(json_extract(w.payload_json, '$.album.cohesion'),    1.0) AS w_cohesion,
    coalesce(json_extract(w.payload_json, '$.album.ambition'),    1.0) AS w_ambition,
    coalesce(json_extract(w.payload_json, '$.release.tracks'),     0.7) AS w_tracks,
    coalesce(json_extract(w.payload_json, '$.release.album_axes'), 0.3) AS w_album_axes,
    coalesce(json_extract(w.payload_json, '$.release.trim_lowest'), 1)  AS trim_lowest,
    coalesce(json_extract(w.payload_json, '$.release.interlude'), 0.5) AS w_interlude,
    coalesce(json_extract(w.payload_json, '$.release.length'),    0.0) AS length_influence,
    coalesce(json_extract(w.payload_json, '$.release.outlier_gap'), 20.0) AS outlier_gap,
    coalesce(json_extract(w.payload_json, '$.release.harshness'), 2.0) AS harshness
FROM app_user u
LEFT JOIN weights w ON w.user_id = u.id AND w.active = 1;

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
        w.outlier_gap,
        w.harshness,
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
        CASE WHEN rated.q <= m.median - rated.outlier_gap THEN 'low'
             WHEN rated.q >= m.median + rated.outlier_gap THEN 'high' END AS side
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
                               ELSE (1.0 - length_influence) + length_influence * length_ms / mean_length END
                        * (1.0 + harshness * max(0.0, 70.0 - q) / 30.0) * q)
        / nullif(sum(kind_weight * CASE WHEN length_ms IS NULL OR mean_length IS NULL THEN 1.0
                                        ELSE (1.0 - length_influence) + length_influence * length_ms / mean_length END
                                 * (1.0 + harshness * max(0.0, 70.0 - q) / 30.0)), 0)
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

-- Scores move: caches keyed on the scores stamp are worked out again.
UPDATE app_setting SET value = CAST(value AS INTEGER) + 1 WHERE key = 'scores_version';
