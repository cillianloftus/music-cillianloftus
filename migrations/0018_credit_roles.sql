-- Migration number: 0018
--
-- Credit roles become data rather than a CHECK list, so new ones (Lead
-- Vocals, Mastering Engineer, Percussion, whatever a sleeve says) can be
-- added from the app. Each role has a family that decides where it is
-- listed and which roles count as "writing" for the gaps and lookups.
--
-- artist_credit is rebuilt to swap its CHECK for a reference: SQLite
-- cannot alter a CHECK. No view refers to it; its two triggers are
-- recreated as they were.

CREATE TABLE credit_role (
    id        TEXT PRIMARY KEY NOT NULL CHECK (id GLOB '[a-z]*' AND id NOT GLOB '*[^a-z_]*'),
    label     TEXT NOT NULL CHECK (label <> ''),
    family    TEXT NOT NULL
              CHECK (family IN ('artist', 'writing', 'production', 'engineering', 'performance', 'other')),
    position  INTEGER NOT NULL DEFAULT 100,
    -- Built-in roles are relied on by code (primary, featured, writer…) and
    -- cannot be removed; added ones can, while unused.
    builtin   INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    UNIQUE (label COLLATE NOCASE)
) STRICT;

INSERT INTO credit_role (id, label, family, position, builtin) VALUES
    ('primary',              'Artist',                 'artist',      1,  1),
    ('featured',             'Featuring',              'artist',      2,  1),
    ('writer',               'Writer',                 'writing',     10, 1),
    ('composer',             'Composer',               'writing',     11, 1),
    ('lyricist',             'Lyricist',               'writing',     12, 1),
    ('arranger',             'Arranger',               'writing',     13, 1),
    ('producer',             'Producer',               'production',  20, 1),
    ('co_producer',          'Co-producer',            'production',  21, 1),
    ('additional_producer',  'Additional producer',    'production',  22, 1),
    ('vocal_producer',       'Vocal producer',         'production',  23, 1),
    ('remixer',              'Remixer',                'production',  24, 1),
    ('programming',          'Programming',            'production',  25, 1),
    ('mixer',                'Mixing engineer',        'engineering', 30, 1),
    ('mastering_engineer',   'Mastering engineer',     'engineering', 31, 1),
    ('recording_engineer',   'Recording engineer',     'engineering', 32, 1),
    ('engineer',             'Engineer',               'engineering', 33, 1),
    ('lead_vocals',          'Lead vocals',            'performance', 40, 1),
    ('background_vocals',    'Background vocals',      'performance', 41, 1),
    ('guitar',               'Guitar',                 'performance', 42, 1),
    ('bass',                 'Bass',                   'performance', 43, 1),
    ('drums',                'Drums',                  'performance', 44, 1),
    ('keyboards',            'Keyboards',              'performance', 45, 1),
    ('piano',                'Piano',                  'performance', 46, 1),
    ('percussion',           'Percussion',             'performance', 47, 1),
    ('strings',              'Strings',                'performance', 48, 1),
    ('performer',            'Performer',              'performance', 49, 1);

CREATE TABLE artist_credit_new (
    id           TEXT PRIMARY KEY NOT NULL,
    entity_type  TEXT NOT NULL
                 CHECK (entity_type IN ('release_group', 'release', 'recording')),
    entity_id    TEXT NOT NULL,
    artist_id    TEXT NOT NULL REFERENCES artist (id),
    role         TEXT NOT NULL REFERENCES credit_role (id),
    position     INTEGER NOT NULL DEFAULT 1 CHECK (position >= 1),
    credited_as  TEXT CHECK (credited_as <> ''),
    join_phrase  TEXT NOT NULL DEFAULT '',

    UNIQUE (entity_type, entity_id, artist_id, role)
) STRICT;

INSERT INTO artist_credit_new (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
SELECT id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase FROM artist_credit;

DROP TABLE artist_credit;
ALTER TABLE artist_credit_new RENAME TO artist_credit;

CREATE INDEX artist_credit_entity ON artist_credit (entity_type, entity_id, role, position);
CREATE INDEX artist_credit_artist ON artist_credit (artist_id, role, entity_type);

CREATE TRIGGER artist_credit_entity_exists_insert
BEFORE INSERT ON artist_credit
WHEN NOT CASE NEW.entity_type
    WHEN 'release_group' THEN EXISTS (SELECT 1 FROM release_group WHERE id = NEW.entity_id)
    WHEN 'release'       THEN EXISTS (SELECT 1 FROM release       WHERE id = NEW.entity_id)
    WHEN 'recording'     THEN EXISTS (SELECT 1 FROM recording     WHERE id = NEW.entity_id)
END
BEGIN
    SELECT RAISE(ABORT, 'artist_credit references a missing entity');
END;

CREATE TRIGGER artist_credit_entity_exists_update
BEFORE UPDATE OF entity_type, entity_id ON artist_credit
WHEN NOT CASE NEW.entity_type
    WHEN 'release_group' THEN EXISTS (SELECT 1 FROM release_group WHERE id = NEW.entity_id)
    WHEN 'release'       THEN EXISTS (SELECT 1 FROM release       WHERE id = NEW.entity_id)
    WHEN 'recording'     THEN EXISTS (SELECT 1 FROM recording     WHERE id = NEW.entity_id)
END
BEGIN
    SELECT RAISE(ABORT, 'artist_credit references a missing entity');
END;
