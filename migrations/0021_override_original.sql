-- Migration number: 0021
--
-- What a hand edit replaced, so the edit can be undone, and so changing a
-- field back to that value stops it counting as edited. JSON, like
-- value_json; NULL where it was not recorded (edits made before this).
ALTER TABLE field_override ADD COLUMN original_json TEXT CHECK (original_json IS NULL OR json_valid(original_json));
