-- The official-release check (src/lib/official.ts) runs every minute while
-- there is anything to check. It found its artists by walking every artist
-- with a MusicBrainz id and testing each for a primary credit on a
-- MusicBrainz album: about 34,000 rows a run, most often to find none.
-- It now starts from the albums not yet checked, and from artists whose
-- last check is old, each a short range of one of these.
CREATE INDEX release_group_unchecked ON release_group (created_at)
  WHERE official IS NULL AND mbid IS NOT NULL;

CREATE INDEX artist_releases_checked ON artist (releases_checked_at)
  WHERE releases_checked_at IS NOT NULL;

-- A new role goes last in its family: max(position) for the family was a
-- read of every role (315) for each role an import brought.
CREATE INDEX credit_role_family ON credit_role (family, position);
