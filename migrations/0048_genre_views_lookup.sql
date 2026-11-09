-- Migration 0048: genre views that can be read for one album or song.
--
-- v_release_group_genre (0005) took the highest weight per album and genre
-- with GROUP BY, which SQLite has to build for the whole library before it
-- can join it: 22,500 rows read to find one album's genres, and the same
-- again for one song's through v_recording_genre, which inherits from it.
-- The artist page, genre pages, track pages and discovered insights all
-- paid that per use.
--
-- A tag is unique per (album, genre, source), so the highest one can be
-- picked without grouping: keep a tag when no other tag for the same album
-- and genre beats it (higher weight, then the earlier source name). Same
-- manual-wins rule as before. With no grouping the view flattens into the
-- query that uses it: one album's genres read 6 rows, one song's 10. Read
-- whole it costs a little more (28,700 rows against 22,500), and the rows
-- came out identical on production (3,091 album genres, 20,525 song
-- genres, same weights).
--
-- Also: release_group (created_at), for Recently added, which sorted every
-- album (and worked out each one's standard edition and score) to show 24.

DROP VIEW v_recording_genre;
DROP VIEW v_release_group_genre;

CREATE VIEW v_release_group_genre AS
SELECT t.entity_id AS release_group_id, t.genre_id, t.weight
FROM genre_tag t
WHERE t.entity_type = 'release_group'
  AND (t.source = 'manual'
       OR NOT EXISTS (SELECT 1 FROM genre_tag m
                      WHERE m.entity_type = 'release_group'
                        AND m.entity_id = t.entity_id
                        AND m.source = 'manual'))
  AND NOT EXISTS (SELECT 1 FROM genre_tag b
                  WHERE b.entity_type = 'release_group'
                    AND b.entity_id = t.entity_id
                    AND b.genre_id = t.genre_id
                    AND b.source <> t.source
                    AND (b.weight > t.weight OR (b.weight = t.weight AND b.source < t.source)));

-- As 0005, over the view above.
CREATE VIEW v_recording_genre AS
SELECT t.entity_id AS recording_id, t.genre_id, max(t.weight) AS weight
FROM genre_tag t
WHERE t.entity_type = 'recording'
  AND (t.source = 'manual'
       OR NOT EXISTS (SELECT 1 FROM genre_tag m
                      WHERE m.entity_type = 'recording'
                        AND m.entity_id = t.entity_id
                        AND m.source = 'manual'))
GROUP BY t.entity_id, t.genre_id
UNION ALL
SELECT tr.recording_id, rg.genre_id, max(rg.weight) AS weight
FROM track tr
JOIN release r ON r.id = tr.release_id
JOIN v_release_group_genre rg ON rg.release_group_id = r.release_group_id
WHERE NOT EXISTS (SELECT 1 FROM genre_tag own
                  WHERE own.entity_type = 'recording' AND own.entity_id = tr.recording_id)
GROUP BY tr.recording_id, rg.genre_id;

CREATE INDEX release_group_created ON release_group (created_at);
