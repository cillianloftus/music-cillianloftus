-- Lyrics marked wrong on Now playing: an LRCLIB entry that is not this
-- song's (17 Nov: every LRCLIB entry for Logic's "Welcome to Forever" is
-- DJ Khaled's "Welcome to My Hood"). Never shown for it again, nor any
-- other entry with the same words.
CREATE TABLE lyrics_rejected (
  recording_id TEXT NOT NULL REFERENCES recording (id),
  lrclib_id INTEGER NOT NULL,
  rejected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (recording_id, lrclib_id)
);
