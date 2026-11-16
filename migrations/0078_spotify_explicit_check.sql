-- Migration 0078: albums checked for a clean edition linked in place of the original.
--
-- Spotify lists a clean edition beside the explicit one, alike in name,
-- year and length, and the linker took whichever came first: Kamikaze
-- played censored (16 Nov). The nightly check looks at a few linked albums
-- a night (rated or played first) and switches any linked to a clean
-- edition over to the explicit one; a checked album is not looked at again
-- for half a year.

CREATE TABLE spotify_explicit_check (
    release_group_id TEXT PRIMARY KEY NOT NULL,
    checked_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;
