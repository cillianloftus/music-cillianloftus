-- Migration number: 0031
--
-- The genre editor suggests parents from MusicBrainz's genre relationships
-- (src/lib/genre-suggest.ts). A suggestion turned down stays turned down:
-- this remembers which, by the suggested parent's name key (genreKey), so
-- it holds even for a parent not yet in the library.

CREATE TABLE genre_suggestion_dismissed (
    genre_id    TEXT NOT NULL REFERENCES genre (id) ON DELETE CASCADE,
    parent_key  TEXT NOT NULL CHECK (parent_key <> ''),

    PRIMARY KEY (genre_id, parent_key)
) STRICT;
