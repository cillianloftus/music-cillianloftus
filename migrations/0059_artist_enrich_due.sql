-- Migration 0059: finding the artists due a look on MusicBrainz.
--
-- The nightly run and the catch-up pick artists never looked up, or not in
-- ninety days. Without an index on when each was last looked at, every
-- pick scanned the whole artist table (11,000 rows a time, 8,600 times on
-- a catch-up day). Only artists with a MusicBrainz id are ever picked.

CREATE INDEX artist_enrich_due ON artist (enriched_at) WHERE mbid IS NOT NULL;
