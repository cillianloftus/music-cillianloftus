-- Migration 0079: your own audio, stored privately and played back to you.
--
-- Until now the file catalogue held paths on Cillian's machine and nothing
-- more: no audio was hosted. On 16 Nov he chose to be able to play his own
-- files whenever and wherever, so a catalogued file may now have its audio
-- uploaded to a private R2 bucket (AUDIO_STORE). It is served only to him,
-- signed in (src/pages/audio/[id].ts), never publicly, and nothing is ever
-- fetched from a streaming service.

ALTER TABLE file ADD COLUMN audio_key TEXT;
ALTER TABLE file ADD COLUMN audio_bytes INTEGER;
ALTER TABLE file ADD COLUMN uploaded_at TEXT;

-- What can be played, by song: the player and the Play buttons ask this.
CREATE INDEX file_playable ON file (recording_id) WHERE audio_key IS NOT NULL;
