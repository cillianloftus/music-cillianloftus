-- MusicBrainz names the label of a self-released record "[no label]". That
-- is the absence of a label, not one, so it is stored as NULL like any
-- other missing value (the importer no longer writes it). Labels set by
-- hand are left as they are.
UPDATE release
SET label = NULL
WHERE label = '[no label]'
  AND id NOT IN (SELECT entity_id FROM field_override WHERE entity_type = 'release' AND field = 'label');
