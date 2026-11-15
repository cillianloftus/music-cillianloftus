-- Migration 0075: versions of a song share its score until rated themselves.
--
-- Cillian, 15 Nov: "if there's five versions, and only one is rated, all
-- the others should pull that rating unless they get their own rating."
-- A version is a recording of the same work by the same artist (a cover
-- by someone else shares the work, never the score). It takes the score of
-- the work's preferred recording when that is rated, else of the version
-- rated most recently.
--
-- Kept, not worked out on each read: the song score view is joined almost
-- everywhere, and finding each song's rated version on every read would
-- cost more and nest deeper than production allows. src/lib/inherited.ts
-- rebuilds inherited_score after a rating, a gut conversion or weights
-- change, nightly, and for an import's new songs. A song's own rating wins
-- at once: the view leaves out a borrowed score the moment one exists.
--
-- v_recording_score keeps its name and columns (and gains "inherited"),
-- so everything that reads it, album scores included, counts borrowed
-- scores. src/lib/scoring.ts (computeScores, inputs.inherits) is the twin.

CREATE TABLE inherited_score (
    user_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    from_recording_id TEXT NOT NULL,
    quality_score REAL NOT NULL,
    personal_score REAL NOT NULL,
    depth TEXT,
    PRIMARY KEY (user_id, recording_id)
) WITHOUT ROWID;

CREATE INDEX inherited_score_recording ON inherited_score (recording_id);

DROP VIEW v_release_score;
DROP VIEW v_recording_score;

CREATE VIEW v_recording_own_score AS
SELECT
    a.entity_id AS recording_id,
    a.user_id,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + coalesce(g.gut_offset, c.gut_offset))))
        AS quality_score,
    max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + coalesce(g.gut_offset, c.gut_offset))))
        + coalesce(a.impact, 0)
        AS personal_score,
    a.depth,
    a.rated_at
FROM v_latest_rating_axes a
JOIN v_gut_calibration c ON c.user_id = a.user_id
LEFT JOIN gut_conversion g ON g.user_id = a.user_id AND g.recording_id = a.entity_id
WHERE a.entity_type = 'recording'
  AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = a.entity_id AND k.kind = 'skit');

CREATE VIEW v_recording_score AS
SELECT recording_id, user_id, quality_score, personal_score, depth, 0 AS inherited
FROM v_recording_own_score
UNION ALL
SELECT i.recording_id, i.user_id, i.quality_score, i.personal_score, i.depth, 1 AS inherited
FROM inherited_score i
WHERE NOT EXISTS (SELECT 1 FROM rating x WHERE x.user_id = i.user_id AND x.entity_type = 'recording' AND x.entity_id = i.recording_id)
  AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = i.recording_id AND k.kind = 'skit');

CREATE VIEW v_release_score AS
WITH
canonical_tracks AS (
    SELECT DISTINCT x.release_group_id, x.id AS release_id, t.recording_id
    FROM (SELECT entity_id AS recording_id FROM rating WHERE entity_type = 'recording'
          UNION SELECT recording_id FROM inherited_score) rr
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
