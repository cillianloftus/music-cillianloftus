-- Migration number: 0012
--
-- The genre tree is now edited by hand (/edit/genres), so the database
-- refuses a cycle: a genre may not sit beneath itself, at any depth. A
-- cycle would make every "pop and everything beneath it" query recurse
-- forever.

CREATE TRIGGER genre_no_cycle_update
BEFORE UPDATE OF parent_id ON genre
WHEN NEW.parent_id IS NOT NULL AND (
    NEW.parent_id = NEW.id
    OR NEW.id IN (
        WITH RECURSIVE up(id) AS (
            SELECT NEW.parent_id
            UNION
            SELECT g.parent_id FROM genre g JOIN up ON g.id = up.id WHERE g.parent_id IS NOT NULL
        )
        SELECT id FROM up
    )
)
BEGIN
    SELECT RAISE(ABORT, 'a genre cannot sit beneath itself');
END;

CREATE TRIGGER genre_no_self_parent_insert
BEFORE INSERT ON genre
WHEN NEW.parent_id = NEW.id
BEGIN
    SELECT RAISE(ABORT, 'a genre cannot sit beneath itself');
END;
