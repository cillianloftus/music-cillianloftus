-- The review queue, made to be worked through (src/lib/review.ts, merge.ts).
--
-- Skip: an item put to the back of its list for later, not decided.
ALTER TABLE anomaly ADD COLUMN skipped_at TEXT;

-- A merge deletes the emptied row once everything has moved to the one
-- kept. The row itself is kept here, whole, beside the redirect that sends
-- its old address on, so a merge that turns out wrong can be undone by hand.
ALTER TABLE entity_redirect ADD COLUMN snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json));
ALTER TABLE entity_redirect ADD COLUMN merged_at TEXT;
