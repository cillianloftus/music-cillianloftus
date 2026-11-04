-- Migration number: 0005
--
-- Views the query layer (src/lib/query) reads, so genre and album rules
-- live in one place rather than in every compiled query.


-- A release group's genres. Manual tags win: when any exist, other sources
-- are ignored for that release group.
CREATE VIEW v_release_group_genre AS
SELECT t.entity_id AS release_group_id, t.genre_id, max(t.weight) AS weight
FROM genre_tag t
WHERE t.entity_type = 'release_group'
  AND (t.source = 'manual'
       OR NOT EXISTS (SELECT 1 FROM genre_tag m
                      WHERE m.entity_type = 'release_group'
                        AND m.entity_id = t.entity_id
                        AND m.source = 'manual'))
GROUP BY t.entity_id, t.genre_id;


-- A recording's genres: its own tags (manual winning) if it has any,
-- otherwise those of every release group it appears on. A track may
-- override its album's genre entirely (ARCHITECTURE.md §3, Genre).
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


-- The album a recording belongs to, for display and grouping: an album
-- over singles and compilations, then the earliest.
CREATE VIEW v_recording_album AS
SELECT recording_id, release_group_id
FROM (
    SELECT
        tr.recording_id,
        r.release_group_id,
        row_number() OVER (
            PARTITION BY tr.recording_id
            ORDER BY g.type = 'album' DESC,
                     g.first_release_date IS NULL,
                     substr(g.first_release_date || '-99-99', 1, 10),
                     g.created_at
        ) AS n
    FROM track tr
    JOIN release r ON r.id = tr.release_id
    JOIN release_group g ON g.id = r.release_group_id
)
WHERE n = 1;
