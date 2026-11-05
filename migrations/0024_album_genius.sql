-- Migration number: 0024
--
-- An album's Genius page, for its links. Learned from its tracks' Genius
-- lookups, when Genius files a track on an album of the same title.
ALTER TABLE release_group ADD COLUMN genius_url TEXT CHECK (genius_url GLOB 'https://genius.com/*');
