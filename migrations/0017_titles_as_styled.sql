-- A recording's title as styled on its release, where the two differ only
-- in capitals: MusicBrainz names the recording "Born Yesterday", the album
-- prints "born yesterday", and the album is how the artist styled it.
-- The earliest release with a styled title wins; a title edited by hand is
-- left alone. src/lib/import/write.ts applies the same rule to new rows.
UPDATE recording
SET title = (
    SELECT t.title_on_release
    FROM track t JOIN release x ON x.id = t.release_id
    WHERE t.recording_id = recording.id
      AND t.title_on_release IS NOT NULL
      AND lower(t.title_on_release) = lower(recording.title)
    ORDER BY x.date IS NULL, x.date, x.created_at
    LIMIT 1
)
WHERE EXISTS (
    SELECT 1 FROM track t
    WHERE t.recording_id = recording.id
      AND t.title_on_release IS NOT NULL
      AND t.title_on_release <> recording.title
      AND lower(t.title_on_release) = lower(recording.title)
)
AND NOT EXISTS (
    SELECT 1 FROM field_override o
    WHERE o.entity_type = 'recording' AND o.entity_id = recording.id AND o.field = 'title'
);
