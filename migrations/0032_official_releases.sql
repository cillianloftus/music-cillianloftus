-- Official releases only (src/lib/official.ts).
--
-- MusicBrainz holds every bootleg, fan-made "album" and unofficial mixtape
-- anyone has entered; its own site hides them. Imports now ask for the
-- same view, and what came in before is checked against it: `official` is
-- NULL until checked, then whether MusicBrainz lists the group as having
-- an official release. Cillian removes the unofficial ones (or keeps one,
-- `keep_unofficial`) from /manage/unofficial.
ALTER TABLE release_group ADD COLUMN official INTEGER CHECK (official IN (0, 1));
ALTER TABLE release_group ADD COLUMN keep_unofficial INTEGER NOT NULL DEFAULT 0 CHECK (keep_unofficial IN (0, 1));

-- When an artist's release groups were last checked against MusicBrainz.
ALTER TABLE artist ADD COLUMN releases_checked_at TEXT;

-- A removed album, kept whole: every row it took with it, so it can be
-- put back, and its MusicBrainz id, so a discography import never brings
-- it back on its own.
CREATE TABLE removed_release_group (
    id             TEXT PRIMARY KEY NOT NULL,
    mbid           TEXT,
    title          TEXT NOT NULL,
    artist         TEXT,
    reason         TEXT NOT NULL CHECK (reason IN ('unofficial', 'not_wanted')),
    snapshot_json  TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    removed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX removed_release_group_mbid ON removed_release_group (mbid);
CREATE INDEX release_group_official ON release_group (official) WHERE official = 0;
