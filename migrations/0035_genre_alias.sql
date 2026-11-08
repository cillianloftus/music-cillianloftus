-- Renaming a genre (src/lib/genres.ts, renameGenre). Every tag points at
-- the genre by id, so a rename reaches every album and track at once; the
-- old name stays here so an import that still says "hip hop" lands on what
-- is now "hip-hop" rather than bringing the old name back as a new genre.
-- Renaming onto an existing genre merges the two, and the merged-away
-- name is kept the same way.
CREATE TABLE genre_alias (
    name      TEXT PRIMARY KEY NOT NULL COLLATE NOCASE CHECK (name <> ''),
    genre_id  TEXT NOT NULL REFERENCES genre (id) ON DELETE CASCADE
) STRICT;

CREATE INDEX genre_alias_genre ON genre_alias (genre_id);
