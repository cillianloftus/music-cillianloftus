-- Migration number: 0006
--
-- Closes a hole in the date/precision CHECK constraints from 0001 and 0002.
-- Each is an OR of branches like
--     (date_precision = 'year' AND first_release_date GLOB '[0-9][0-9][0-9][0-9]')
-- and when the date is NULL, `NULL GLOB ...` is NULL rather than false. A
-- CHECK that evaluates to NULL passes, so a NULL date with precision 'year'
-- was accepted. SQLite cannot alter a CHECK in place, so the rule is added
-- as triggers: a NULL date must have precision 'unknown'.
--
-- (Found by src/test/migrations.test.ts. No existing rows violated it.)

CREATE TRIGGER recording_date_precision_insert
BEFORE INSERT ON recording
WHEN NEW.first_release_date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER recording_date_precision_update
BEFORE UPDATE OF first_release_date, date_precision ON recording
WHEN NEW.first_release_date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER release_group_date_precision_insert
BEFORE INSERT ON release_group
WHEN NEW.first_release_date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER release_group_date_precision_update
BEFORE UPDATE OF first_release_date, date_precision ON release_group
WHEN NEW.first_release_date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER release_date_precision_insert
BEFORE INSERT ON release
WHEN NEW.date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER release_date_precision_update
BEFORE UPDATE OF date, date_precision ON release
WHEN NEW.date IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER holding_date_precision_insert
BEFORE INSERT ON holding
WHEN NEW.acquired_at IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;

CREATE TRIGGER holding_date_precision_update
BEFORE UPDATE OF acquired_at, date_precision ON holding
WHEN NEW.acquired_at IS NULL AND NEW.date_precision <> 'unknown'
BEGIN
    SELECT RAISE(ABORT, 'a missing date must have precision unknown');
END;
