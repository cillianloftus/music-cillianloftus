-- Migration number: 0019
--
-- A line about an edition that no field holds: "Pulled from streaming in
-- 2024", "Tour vinyl, 300 copies". Shown with the edition, never parsed.
ALTER TABLE release ADD COLUMN note TEXT CHECK (note <> '' AND length(note) <= 300);
