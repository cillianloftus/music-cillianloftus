-- Migration number: 0030
--
-- v_recording_first_art, same answer, cheap to look up. The 0027 view
-- ranked every track in the library with a window function, so looking up
-- even one recording built the whole ranking first: seconds on a full
-- library. This one reads only that recording's own tracks (through
-- track_recording), so a lookup or join touches a handful of rows.
--
-- A track's picture: the cover of the release it first came out on. A
-- single that came before its album shows the single's art; when the
-- album came first, the album's. Ties on the same date prefer the album.
-- Recordings with no art on any release have NULLs here, where 0027 left
-- them out; every use is a LEFT JOIN or a coalesce, so nothing changes.
DROP VIEW v_recording_first_art;

CREATE VIEW v_recording_first_art AS
SELECT rec.id AS recording_id,
       (SELECT x.art_key
        FROM track t
        JOIN release r ON r.id = t.release_id
        JOIN release_group g ON g.id = r.release_group_id
        JOIN v_release_group_canonical c ON c.release_group_id = g.id
        JOIN release x ON x.id = c.release_id
        WHERE t.recording_id = rec.id AND x.art_key IS NOT NULL
        ORDER BY g.first_release_date IS NULL,
                 substr(g.first_release_date || '-99-99', 1, 10),
                 g.type <> 'album',
                 g.created_at,
                 g.id
        LIMIT 1) AS art_key,
       (SELECT g.id
        FROM track t
        JOIN release r ON r.id = t.release_id
        JOIN release_group g ON g.id = r.release_group_id
        JOIN v_release_group_canonical c ON c.release_group_id = g.id
        JOIN release x ON x.id = c.release_id
        WHERE t.recording_id = rec.id AND x.art_key IS NOT NULL
        ORDER BY g.first_release_date IS NULL,
                 substr(g.first_release_date || '-99-99', 1, 10),
                 g.type <> 'album',
                 g.created_at,
                 g.id
        LIMIT 1) AS release_group_id
FROM recording rec;
