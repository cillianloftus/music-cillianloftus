-- Migration number: 0004
--
-- The canonical edition (whose tracklist stands for the album) used the
-- earliest date and nothing else. Editions often share a release day, so
-- ties fell to whichever was imported first, and a CD with bonus tracks
-- could stand in for the standard album. Same rule as the importer's choice
-- of edition now (src/lib/import/musicbrainz.ts, chooseRelease):
--
--   1. preferred_release_id, when set by hand
--   2. earliest date, a partial date sorting after the full dates it covers
--      ('1977' after '1977-02-04')
--   3. fewest tracks
--   4. earliest imported, then id, so the result is stable

DROP VIEW v_release_group_canonical;

CREATE VIEW v_release_group_canonical AS
SELECT
    g.id AS release_group_id,
    coalesce(
        g.preferred_release_id,
        (SELECT r.id
         FROM release r
         WHERE r.release_group_id = g.id
         ORDER BY
             r.date IS NULL,
             substr(r.date || '-99-99', 1, 10),
             (SELECT count(*) FROM track t WHERE t.release_id = r.id),
             r.created_at,
             r.id
         LIMIT 1)
    ) AS release_id
FROM release_group g;
