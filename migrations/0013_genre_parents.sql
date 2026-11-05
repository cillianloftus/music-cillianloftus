-- Migration number: 0013
--
-- Genres can have more than one parent. Blues rock is blues and it is rock;
-- a strict tree forces a false choice. Each genre keeps its primary parent
-- (genre.parent_id), which decides its colour family and where it is drawn;
-- any further parents live here.
--
-- v_genre_edge is every parent link, primary or not. Anything asking for
-- "this genre and everything beneath it" walks it, so a playlist of blues
-- finds blues rock even though it is filed under rock.

CREATE TABLE genre_extra_parent (
    genre_id   TEXT NOT NULL REFERENCES genre (id),
    parent_id  TEXT NOT NULL REFERENCES genre (id),

    PRIMARY KEY (genre_id, parent_id),
    CHECK (genre_id <> parent_id)
) STRICT;

CREATE INDEX genre_extra_parent_by_parent ON genre_extra_parent (parent_id);

CREATE VIEW v_genre_edge AS
SELECT id AS genre_id, parent_id, 1 AS is_primary FROM genre WHERE parent_id IS NOT NULL
UNION ALL
SELECT genre_id, parent_id, 0 AS is_primary FROM genre_extra_parent;


-- Cycles are refused across both kinds of link. The 0012 trigger only
-- knew primary parents.
DROP TRIGGER genre_no_cycle_update;

CREATE TRIGGER genre_no_cycle_update
BEFORE UPDATE OF parent_id ON genre
WHEN NEW.parent_id IS NOT NULL AND (
    NEW.parent_id = NEW.id
    OR NEW.id IN (
        WITH RECURSIVE up(id) AS (
            SELECT NEW.parent_id
            UNION
            SELECT e.parent_id FROM v_genre_edge e JOIN up ON e.genre_id = up.id
        )
        SELECT id FROM up
    )
)
BEGIN
    SELECT RAISE(ABORT, 'a genre cannot sit beneath itself');
END;

CREATE TRIGGER genre_parent_no_cycle
BEFORE INSERT ON genre_extra_parent
WHEN NEW.genre_id IN (
    WITH RECURSIVE up(id) AS (
        SELECT NEW.parent_id
        UNION
        SELECT e.parent_id FROM v_genre_edge e JOIN up ON e.genre_id = up.id
    )
    SELECT id FROM up
)
BEGIN
    SELECT RAISE(ABORT, 'a genre cannot sit beneath itself');
END;
