-- The standard edition prefers a plainly titled one. 0004 took the earliest
-- date first, so a "Special Edition" dated a year before the plain album
-- (Nine Track Mind: 2015 against 2016) stood for the album, bonus tracks and
-- all. Now, after a hand choice, an edition whose title carries no edition
-- words comes before one that does; then 0004's order. The same words as
-- src/lib/editions.ts (isEditionTitle), which the importer and the album
-- page use, so all three agree.

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
             (lower(r.title) GLOB '*deluxe*' OR lower(r.title) GLOB '*special*' OR lower(r.title) GLOB '*expanded*'
              OR lower(r.title) GLOB '*anniversary*' OR lower(r.title) GLOB '*remaster*' OR lower(r.title) GLOB '*bonus*'
              OR lower(r.title) GLOB '*edition*' OR lower(r.title) GLOB '*collector*'),
             r.date IS NULL,
             substr(r.date || '-99-99', 1, 10),
             (SELECT count(*) FROM track t WHERE t.release_id = r.id),
             r.created_at,
             r.id
         LIMIT 1)
    ) AS release_id
FROM release_group g;
