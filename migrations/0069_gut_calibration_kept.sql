-- Migration 0069: the general gut gap is kept, not worked out on every read.
--
-- v_gut_calibration found each song's latest rating with both a gut and a
-- detailed score, every time anything read a recording's score: 6,162 of
-- the 8,754 rows v_recording_score read on production (14 Nov 2026), on
-- every page with a score. It changes only when a detailed rating does, so
-- it is kept in gut_calibration, worked out by the same code as each song's
-- gut_conversion (src/lib/gut-calibration.ts: the minute after a rating that
-- moves it, on new weights, and nightly), and the view reads one row.
--
-- Filled here from the view as it stood, so scores do not move meanwhile.

CREATE TABLE gut_calibration (
    user_id      TEXT PRIMARY KEY NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    -- Added to a gut score with no conversion of its own, and to an album's.
    gut_offset   REAL NOT NULL,
    -- Songs rated both ways it rests on.
    sample_size  INTEGER NOT NULL
);

INSERT INTO gut_calibration (user_id, gut_offset, sample_size)
SELECT user_id, gut_offset, sample_size FROM v_gut_calibration;

DROP VIEW v_gut_calibration;

CREATE VIEW v_gut_calibration AS
SELECT
    u.id AS user_id,
    coalesce(c.gut_offset, 0) AS gut_offset,
    coalesce(c.sample_size, 0) AS sample_size
FROM app_user u
LEFT JOIN gut_calibration c ON c.user_id = u.id;
