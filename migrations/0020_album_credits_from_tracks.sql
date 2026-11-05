-- Migration number: 0020
--
-- An album's credits beyond its artists are its tracks' (ARCHITECTURE.md,
-- "As built: credits"). Writers, producers and engineers filed on a release
-- or a whole album move onto each track of that release (for an album, its
-- standard edition), then leave the album. Tracks whose credits were edited
-- by hand are left as they are. Artist credits stay where they are.

INSERT OR IGNORE INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
SELECT lower(hex(randomblob(16))), 'recording', t.recording_id, c.artist_id, c.role, c.position, c.credited_as, ''
FROM artist_credit c
JOIN track t ON t.release_id = c.entity_id
WHERE c.entity_type = 'release' AND c.role NOT IN ('primary', 'featured')
  AND NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'recording' AND o.entity_id = t.recording_id AND o.field = 'credits');

INSERT OR IGNORE INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
SELECT lower(hex(randomblob(16))), 'recording', t.recording_id, c.artist_id, c.role, c.position, c.credited_as, ''
FROM artist_credit c
JOIN v_release_group_canonical v ON v.release_group_id = c.entity_id
JOIN track t ON t.release_id = v.release_id
WHERE c.entity_type = 'release_group' AND c.role NOT IN ('primary', 'featured')
  AND NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'recording' AND o.entity_id = t.recording_id AND o.field = 'credits');

DELETE FROM artist_credit WHERE entity_type IN ('release', 'release_group') AND role NOT IN ('primary', 'featured');
