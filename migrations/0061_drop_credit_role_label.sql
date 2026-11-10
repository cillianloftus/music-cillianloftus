-- 0060 duplicated the unique index credit_role already has on label
-- (COLLATE NOCASE). The scan it was meant to stop came from an OR of id
-- and label in one statement, since rewritten as two seeks.
DROP INDEX IF EXISTS credit_role_label;
