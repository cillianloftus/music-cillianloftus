-- Migration 0080: aliases found by name whatever its case.
--
-- Credits name people ("Mike Dean"), and each is found as an artist by name
-- or alias, case aside (credits.ts, artistForCredit). The alias index was
-- case-sensitive, so the lookup read every artist and alias: 55,000 rows a
-- name, a billion rows on 16 Nov as credits were filled in. With this, and
-- the lookup split in two, it is two seeks.

CREATE INDEX IF NOT EXISTS artist_alias_name_nocase ON artist_alias (name COLLATE NOCASE);
