-- Migration 0046: each recording's album, found per recording.
--
-- v_recording_album (0005) ranked every track in the library with a window
-- function and kept the first per recording. SQLite cannot push a filter
-- into a window, so any query that joined it for a page of twenty tracks
-- built the whole ranking first: about 104,000 rows read per use, on the
-- playlist, query, home and recap pages alike.
--
-- Same choice, made by a correlated lookup instead: an album over singles
-- and compilations, then the earliest dated, then the first made (then the
-- id, so ties always fall the same way). A view of a plain table with a
-- scalar subquery flattens into the outer query, so twenty recordings cost
-- twenty lookups through track_recording: about 100 rows on production
-- (10,800 recordings), against 104,000. Read whole it is a little cheaper
-- too (85,600 rows against 90,600), and every recording's album came out
-- the same. Only recordings on some release have a row, as before.

DROP VIEW v_recording_album;

CREATE VIEW v_recording_album AS
SELECT
    rec.id AS recording_id,
    (SELECT r.release_group_id
     FROM track tr
     JOIN release r ON r.id = tr.release_id
     JOIN release_group g ON g.id = r.release_group_id
     WHERE tr.recording_id = rec.id
     ORDER BY g.type = 'album' DESC,
              g.first_release_date IS NULL,
              substr(g.first_release_date || '-99-99', 1, 10),
              g.created_at,
              g.id
     LIMIT 1) AS release_group_id
FROM recording rec
WHERE EXISTS (SELECT 1 FROM track t0 WHERE t0.recording_id = rec.id);
