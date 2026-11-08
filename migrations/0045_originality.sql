-- A sixth craft axis for tracks (8 Nov 2026, Cillian's call): originality,
-- how fresh or distinctive it is. Five axes laid out in pairs left one on
-- its own, and nothing measured novelty.
--
-- Ratings are append-only and never rewritten: older rows have no
-- originality, which leaves it out of their composite (a blank axis is
-- left out, not counted as zero), so no existing score moves. Its weight
-- defaults to 1, like songwriting's.
--
-- As in 0042, the table's own checks name the craft axes, so it is rebuilt
-- with the new column in them; every row is copied unchanged and the
-- append-only triggers made again. The views are made again unchanged but
-- for the weight and the composite.
-- Views that read the table, dropped first (a rename re-checks every
-- view) and made again at the end, unchanged but for the two below.
DROP VIEW v_release_score;
DROP VIEW v_recording_score;
DROP VIEW v_gut_calibration;
DROP VIEW v_latest_rating_axes;
DROP VIEW v_rating_axes;
DROP VIEW v_active_weights;

CREATE TABLE rating_new (
    id           TEXT PRIMARY KEY NOT NULL,
    user_id      TEXT NOT NULL REFERENCES app_user (id),
    entity_type  TEXT NOT NULL CHECK (entity_type IN ('recording', 'release_group')),
    entity_id    TEXT NOT NULL,
    rated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    depth        TEXT NOT NULL CHECK (depth IN ('gut', 'detailed')),

    gut_score    REAL CHECK (gut_score   BETWEEN 0 AND 10),

    -- Craft axes: recordings only. Production on rows before the split only.
    production   REAL CHECK (production  BETWEEN 0 AND 10),
    songwriting  REAL CHECK (songwriting BETWEEN 0 AND 10),
    lyrics       REAL CHECK (lyrics      BETWEEN 0 AND 10),
    performance  REAL CHECK (performance BETWEEN 0 AND 10),

    -- Album axes: release groups only.
    sequencing   REAL CHECK (sequencing  BETWEEN 0 AND 10),
    cohesion     REAL CHECK (cohesion    BETWEEN 0 AND 10),
    ambition     REAL CHECK (ambition    BETWEEN 0 AND 10),

    -- Deliberately sparse. Not a quality measure.
    impact       REAL CHECK (impact      BETWEEN 0 AND 10),
    impact_note  TEXT CHECK (impact_note <> ''),

    not_applicable TEXT
        CHECK (not_applicable IS NULL OR (json_valid(not_applicable) AND json_type(not_applicable) = 'array')),

    arrangement  REAL CHECK (arrangement BETWEEN 0 AND 10),
    sound        REAL CHECK (sound       BETWEEN 0 AND 10),
    originality  REAL CHECK (originality BETWEEN 0 AND 10),

    UNIQUE (user_id, entity_type, entity_id, rated_at),

    CHECK (entity_type = 'recording' OR
           (production IS NULL AND arrangement IS NULL AND sound IS NULL
            AND songwriting IS NULL AND lyrics IS NULL AND performance IS NULL
            AND originality IS NULL)),
    CHECK (entity_type = 'release_group' OR
           (sequencing IS NULL AND cohesion IS NULL AND ambition IS NULL)),

    -- A row before the split has production; one after has the halves.
    CHECK (production IS NULL OR (arrangement IS NULL AND sound IS NULL)),

    CHECK (
        (depth = 'gut' AND gut_score IS NOT NULL
            AND coalesce(production, arrangement, sound, songwriting, lyrics, performance, originality,
                         sequencing, cohesion, ambition) IS NULL)
        OR
        (depth = 'detailed'
            AND coalesce(production, arrangement, sound, songwriting, lyrics, performance, originality,
                         sequencing, cohesion, ambition) IS NOT NULL)
    )
) STRICT;

INSERT INTO rating_new (id, user_id, entity_type, entity_id, rated_at, depth, gut_score,
                        production, arrangement, sound, songwriting, lyrics, performance,
                        sequencing, cohesion, ambition, impact, impact_note, not_applicable)
SELECT id, user_id, entity_type, entity_id, rated_at, depth, gut_score,
       production, arrangement, sound, songwriting, lyrics, performance,
       sequencing, cohesion, ambition, impact, impact_note, not_applicable
FROM rating;

DROP TABLE rating;
ALTER TABLE rating_new RENAME TO rating;

CREATE INDEX rating_entity ON rating (entity_type, entity_id, user_id, rated_at);

-- Rating rows are immutable. The one exception is entity_id, which a merge
-- reparents onto the surviving entity so both histories combine.
CREATE TRIGGER rating_no_update
BEFORE UPDATE OF id, user_id, entity_type, rated_at, depth, gut_score,
                 production, arrangement, sound, songwriting, lyrics, performance, originality,
                 sequencing, cohesion, ambition, impact, impact_note, not_applicable
ON rating
BEGIN
    SELECT RAISE(ABORT, 'rating rows are append-only');
END;

CREATE TRIGGER rating_no_delete
BEFORE DELETE ON rating
BEGIN
    SELECT RAISE(ABORT, 'rating rows are append-only');
END;

CREATE TRIGGER rating_entity_exists_insert
BEFORE INSERT ON rating
WHEN NOT CASE NEW.entity_type
    WHEN 'release_group' THEN EXISTS (SELECT 1 FROM release_group WHERE id = NEW.entity_id)
    WHEN 'recording'     THEN EXISTS (SELECT 1 FROM recording     WHERE id = NEW.entity_id)
END
BEGIN
    SELECT RAISE(ABORT, 'rating references a missing entity');
END;

CREATE TRIGGER rating_entity_exists_update
BEFORE UPDATE OF entity_id ON rating
WHEN NOT CASE NEW.entity_type
    WHEN 'release_group' THEN EXISTS (SELECT 1 FROM release_group WHERE id = NEW.entity_id)
    WHEN 'recording'     THEN EXISTS (SELECT 1 FROM recording     WHERE id = NEW.entity_id)
END
BEGIN
    SELECT RAISE(ABORT, 'rating references a missing entity');
END;


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
    coalesce(json_extract(w.payload_json, '$.release.length'),    0.0) AS length_influence
FROM app_user u
LEFT JOIN weights w ON w.user_id = u.id AND w.active = 1;


-- As 0042, with originality the sixth craft axis; production still stands
-- in for arrangement and sound on rows rated before that split.

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
    (  coalesce(w.w_arrangement * coalesce(r.arrangement, r.production), 0)
     + coalesce(w.w_sound       * coalesce(r.sound, r.production),       0)
     + coalesce(w.w_songwriting * r.songwriting, 0)
     + coalesce(w.w_lyrics      * r.lyrics,      0)
     + coalesce(w.w_performance * r.performance, 0)
     + coalesce(w.w_originality * r.originality, 0))
    / nullif(  (coalesce(r.arrangement, r.production) IS NOT NULL) * w.w_arrangement
             + (coalesce(r.sound, r.production)       IS NOT NULL) * w.w_sound
             + (r.songwriting IS NOT NULL) * w.w_songwriting
             + (r.lyrics      IS NOT NULL) * w.w_lyrics
             + (r.performance IS NOT NULL) * w.w_performance
             + (r.originality IS NOT NULL) * w.w_originality, 0)
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


-- As they were (0003, 0034, 0040).
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
  AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = a.entity_id AND k.kind = 'skit');

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
