-- Migration number: 0003
--
-- Derived scores (ARCHITECTURE.md §3, "Derived scores"). Views only: nothing
-- here is stored, so changing a weight re-ranks the whole library instantly.
--
-- Scales:
--   axes, gut_score, impact      0–10
--   quality_score                0–100, hard capped
--   personal_score               quality_score + impact, 0–110
--
-- Weights come from the user's active `weights` row. Missing keys fall back
-- to the defaults below, so a user with no weights row still gets scores.
-- Payload shape (every key optional):
--
--   {
--     "craft":   { "production": 1, "songwriting": 1, "lyrics": 1, "performance": 1 },
--     "album":   { "sequencing": 1, "cohesion": 1, "ambition": 1 },
--     "release": { "tracks": 0.7, "album_axes": 0.3, "trim_lowest": 1 }
--   }


CREATE VIEW v_active_weights AS
SELECT
    u.id AS user_id,
    coalesce(json_extract(w.payload_json, '$.craft.production'),  1.0) AS w_production,
    coalesce(json_extract(w.payload_json, '$.craft.songwriting'), 1.0) AS w_songwriting,
    coalesce(json_extract(w.payload_json, '$.craft.lyrics'),      1.0) AS w_lyrics,
    coalesce(json_extract(w.payload_json, '$.craft.performance'), 1.0) AS w_performance,
    coalesce(json_extract(w.payload_json, '$.album.sequencing'),  1.0) AS w_sequencing,
    coalesce(json_extract(w.payload_json, '$.album.cohesion'),    1.0) AS w_cohesion,
    coalesce(json_extract(w.payload_json, '$.album.ambition'),    1.0) AS w_ambition,
    coalesce(json_extract(w.payload_json, '$.release.tracks'),     0.7) AS w_tracks,
    coalesce(json_extract(w.payload_json, '$.release.album_axes'), 0.3) AS w_album_axes,
    coalesce(json_extract(w.payload_json, '$.release.trim_lowest'), 1)  AS trim_lowest
FROM app_user u
LEFT JOIN weights w ON w.user_id = u.id AND w.active = 1;


-- Every rating row with its axis composites (0–10), each a weighted mean of
-- whichever axes are present. NULL when the row has no axes of that kind.
CREATE VIEW v_rating_axes AS
SELECT
    r.id AS rating_id,
    r.user_id,
    r.entity_type,
    r.entity_id,
    r.rated_at,
    r.depth,
    r.gut_score,
    r.impact,
    (  coalesce(w.w_production  * r.production,  0)
     + coalesce(w.w_songwriting * r.songwriting, 0)
     + coalesce(w.w_lyrics      * r.lyrics,      0)
     + coalesce(w.w_performance * r.performance, 0))
    / nullif(  (r.production  IS NOT NULL) * w.w_production
             + (r.songwriting IS NOT NULL) * w.w_songwriting
             + (r.lyrics      IS NOT NULL) * w.w_lyrics
             + (r.performance IS NOT NULL) * w.w_performance, 0)
        AS craft_composite,
    (  coalesce(w.w_sequencing * r.sequencing, 0)
     + coalesce(w.w_cohesion   * r.cohesion,   0)
     + coalesce(w.w_ambition   * r.ambition,   0))
    / nullif(  (r.sequencing IS NOT NULL) * w.w_sequencing
             + (r.cohesion   IS NOT NULL) * w.w_cohesion
             + (r.ambition   IS NOT NULL) * w.w_ambition, 0)
        AS album_composite
FROM rating r
JOIN v_active_weights w ON w.user_id = r.user_id;


-- The current rating: the latest row per (user, entity).
CREATE VIEW v_latest_rating_axes AS
SELECT a.*
FROM v_rating_axes a
WHERE a.rated_at = (
    SELECT max(r.rated_at)
    FROM rating r
    WHERE r.user_id = a.user_id
      AND r.entity_type = a.entity_type
      AND r.entity_id = a.entity_id
);


-- How far a user's gut runs from their considered judgement, in axis points.
-- Learned from recording ratings that carry both a gut score and craft axes,
-- across all history. Calibrated gut = gut_score + gut_offset.
-- (Named gut_offset rather than offset, which is an SQL keyword.)
CREATE VIEW v_gut_calibration AS
SELECT
    u.id AS user_id,
    coalesce(avg(a.craft_composite - a.gut_score), 0) AS gut_offset,
    count(a.rating_id) AS sample_size
FROM app_user u
LEFT JOIN v_rating_axes a
       ON a.user_id = u.id
      AND a.entity_type = 'recording'
      AND a.gut_score IS NOT NULL
      AND a.craft_composite IS NOT NULL
GROUP BY u.id;


-- Recording scores. quality_score uses craft axes where present, otherwise
-- the calibrated gut score.
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
WHERE a.entity_type = 'recording';


-- The edition whose tracklist stands for the album: the preferred release,
-- else the earliest dated one.
CREATE VIEW v_release_group_canonical AS
SELECT
    g.id AS release_group_id,
    coalesce(
        g.preferred_release_id,
        (SELECT r.id
         FROM release r
         WHERE r.release_group_id = g.id
         ORDER BY r.date IS NULL, r.date, r.created_at, r.id
         LIMIT 1)
    ) AS release_id
FROM release_group g;


-- Album scores.
--
--   tracks part   mean quality of the rated tracks on the canonical edition,
--                 discarding the single lowest when trim_lowest is on and at
--                 least two tracks are rated
--   album part    album axes composite, else the calibrated album gut score
--
-- With both parts: weighted blend (0.7 / 0.3 by default). With one: that
-- part alone. rated_track_count and track_count are exposed so a definition
-- can demand coverage before trusting the number.
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
FROM blended b;
