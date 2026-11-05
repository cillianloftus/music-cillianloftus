-- Migration number: 0027
--
-- A track's picture: the cover of the release it first came out on. A
-- single that came before its album shows the single's art; when the
-- album came first, the album's. Ties on the same date prefer the album.
CREATE VIEW v_recording_first_art AS
SELECT recording_id, art_key, release_group_id
FROM (
    SELECT t.recording_id, x.art_key, g.id AS release_group_id,
           row_number() OVER (
               PARTITION BY t.recording_id
               ORDER BY g.first_release_date IS NULL,
                        substr(g.first_release_date || '-99-99', 1, 10),
                        g.type <> 'album',
                        g.created_at
           ) AS n
    FROM track t
    JOIN release r ON r.id = t.release_id
    JOIN release_group g ON g.id = r.release_group_id
    JOIN v_release_group_canonical c ON c.release_group_id = g.id
    JOIN release x ON x.id = c.release_id
    WHERE x.art_key IS NOT NULL
)
WHERE n = 1;
