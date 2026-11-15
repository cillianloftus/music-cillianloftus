-- Migration 0076: finding the work that prefers a song.
--
-- A merge clears the merged-away song as any work's preferred recording
-- (merge.ts, official.ts). With no index on the column that read every
-- work (9,300 rows) per merge: 46 million rows on 15 Nov, while the twin
-- backlog was merged. Only works with a preference are indexed.

CREATE INDEX IF NOT EXISTS work_preferred_recording ON work (preferred_recording_id) WHERE preferred_recording_id IS NOT NULL;
