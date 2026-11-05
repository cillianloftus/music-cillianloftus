-- Migration number: 0026
--
-- The credits Cillian cares about most, listed first on every page in this
-- order; the rest follow by family. Set on /edit/roles.
ALTER TABLE credit_role ADD COLUMN key_order INTEGER CHECK (key_order IS NULL OR key_order >= 1);
UPDATE credit_role SET key_order = 1 WHERE id = 'writer';
UPDATE credit_role SET key_order = 2 WHERE id = 'producer';
UPDATE credit_role SET key_order = 3 WHERE id = 'lead_vocals';
UPDATE credit_role SET key_order = 4 WHERE id = 'composer';
UPDATE credit_role SET key_order = 5 WHERE id = 'lyricist';
