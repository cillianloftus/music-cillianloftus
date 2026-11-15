-- Migration 0077: albums Spotify had no match for, and when it was asked.
--
-- The nightly linker took the 25 newest albums with no Spotify id, but kept
-- no note of the ones it could not find, so each night it asked about the
-- same 25 (mixtapes never on Spotify) and never reached the 5,700 behind
-- them: My Beautiful Dark Twisted Fantasy, imported 5 Nov, was never asked
-- about, and its songs read "Not on streaming" (15 Nov). A miss is skipped
-- for a month; a refresh of the album forgets it.

CREATE TABLE spotify_link_miss (
    release_group_id TEXT PRIMARY KEY NOT NULL,
    looked_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;
