-- Track kinds and length in album scores (src/lib/track-kinds.ts).
--
-- Not every track is a song. A skit is not rated and does not count; an
-- interlude counts at a reduced weight (release.interlude, ½ by default);
-- everything else is a song. One setting for the whole site, chosen by
-- Cillian, never by an import. 'song' is stored only when chosen, so a
-- suggestion he has answered is not asked again.
CREATE TABLE recording_kind (
    recording_id  TEXT PRIMARY KEY NOT NULL REFERENCES recording (id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('song', 'interlude', 'skit')),
    set_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX recording_kind_kind ON recording_kind (kind) WHERE kind <> 'song';


-- Two more weights, both off by default so nothing changes until chosen:
--
--   release.interlude  how much an interlude counts beside a song (0–1, ½)
--   release.length     how much a track's length sets its weight (0–1, 0):
--                      at 1 an album's tracks score is its mean per minute,
--                      a track weighted by its length over the album's mean
DROP VIEW v_active_weights;

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
    coalesce(json_extract(w.payload_json, '$.release.trim_lowest'), 1)  AS trim_lowest,
    coalesce(json_extract(w.payload_json, '$.release.interlude'), 0.5) AS w_interlude,
    coalesce(json_extract(w.payload_json, '$.release.length'),    0.0) AS length_influence
FROM app_user u
LEFT JOIN weights w ON w.user_id = u.id AND w.active = 1;


-- A skit has no score: its ratings stay, but nothing ranks or averages it.
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
  AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = a.entity_id AND k.kind = 'skit');


-- Album scores, as 0010, with the tracks part now a weighted mean:
--
--   weight = kind weight (song 1, interlude w_interlude)
--          × ((1 − length_influence) + length_influence × length ÷ mean length)
--
-- where the mean is over the album's rated tracks with a known length (a
-- track of unknown length counts as average). Trimming drops the single
-- lowest-scored track first, ties broken by recording id. Skits are not
-- on the album at all, for the score or for track_count.
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
weighted AS (
    SELECT
        release_group_id,
        user_id,
        n,
        q,
        kind_weight * CASE
            WHEN length_ms IS NULL OR mean_length IS NULL THEN 1.0
            ELSE (1.0 - length_influence) + length_influence * length_ms / mean_length
        END AS weight
    FROM rated
    WHERE NOT (trim_lowest AND n >= 2 AND from_lowest = 1)
),
track_part AS (
    SELECT
        release_group_id,
        user_id,
        max(n) AS n,
        CASE WHEN sum(weight) > 0 THEN sum(weight * q) / sum(weight) END AS tracks_score
    FROM weighted
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
pairs AS (
    SELECT release_group_id, user_id FROM track_part
    UNION
    SELECT release_group_id, user_id FROM album_part
),
parts AS (
    SELECT
        p.release_group_id,
        p.user_id,
        tp.tracks_score,
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


-- A suggestion put off ("Skip"): asked again later, after the rest.
CREATE TABLE recording_kind_skip (
    recording_id  TEXT PRIMARY KEY NOT NULL REFERENCES recording (id) ON DELETE CASCADE,
    skipped_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
