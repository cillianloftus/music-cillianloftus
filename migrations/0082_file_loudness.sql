-- How loud each uploaded file is (integrated loudness, LUFS, measured in
-- the browser as it is uploaded: src/lib/client/loudness.ts), so the player
-- can turn loud masters down to the level Spotify plays songs at (17 Nov:
-- Griptape far louder than the Spotify songs around it). Null until measured.
ALTER TABLE file ADD COLUMN loudness_lufs REAL;
