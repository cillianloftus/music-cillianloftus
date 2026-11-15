-- Migration 0072: jobs grouped by what queued them.
--
-- A discography, an artist refreshed, the whole library refreshed: each is
-- one batch of jobs, named ("Logic: discography"), so the Jobs page shows
-- a few dozen batches with their progress instead of thousands of albums,
-- and a whole batch can be put first, sent back in line or taken out.
--
-- Each batch keeps its own counts by status, by trigger (as 0070 does for
-- the whole queue), so listing them reads one row each. Jobs from before
-- (and single imports, backups, pushes) have no batch.

CREATE TABLE job_batch (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('discography', 'refresh', 'library', 'files', 'other')),
    -- Where the batch is about, when there is a page for it (an artist, an album).
    href TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    queued INTEGER NOT NULL DEFAULT 0,
    running INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX job_batch_created ON job_batch (created_at);

ALTER TABLE job ADD COLUMN batch_id TEXT;

-- Jobs in no batch (single imports, backups, pushes, and everything from
-- before), newest first, without walking the thousands that are batched.
CREATE INDEX job_loose ON job (created_at) WHERE batch_id IS NULL;

-- A batch's jobs in the order they will run.
CREATE INDEX job_batch_member ON job (batch_id, status, priority DESC, created_at) WHERE batch_id IS NOT NULL;

CREATE TRIGGER job_batch_count_insert AFTER INSERT ON job WHEN NEW.batch_id IS NOT NULL
BEGIN
    UPDATE job_batch SET
        queued = queued + (NEW.status = 'queued'),
        running = running + (NEW.status = 'running'),
        done = done + (NEW.status = 'done'),
        failed = failed + (NEW.status = 'failed')
    WHERE id = NEW.batch_id;
END;

CREATE TRIGGER job_batch_count_update AFTER UPDATE OF status, batch_id ON job
WHEN OLD.status IS NOT NEW.status OR OLD.batch_id IS NOT NEW.batch_id
BEGIN
    UPDATE job_batch SET
        queued = max(0, queued - (OLD.status = 'queued')),
        running = max(0, running - (OLD.status = 'running')),
        done = max(0, done - (OLD.status = 'done')),
        failed = max(0, failed - (OLD.status = 'failed'))
    WHERE id = OLD.batch_id;
    UPDATE job_batch SET
        queued = queued + (NEW.status = 'queued'),
        running = running + (NEW.status = 'running'),
        done = done + (NEW.status = 'done'),
        failed = failed + (NEW.status = 'failed')
    WHERE id = NEW.batch_id;
END;

CREATE TRIGGER job_batch_count_delete AFTER DELETE ON job WHEN OLD.batch_id IS NOT NULL
BEGIN
    UPDATE job_batch SET
        queued = max(0, queued - (OLD.status = 'queued')),
        running = max(0, running - (OLD.status = 'running')),
        done = max(0, done - (OLD.status = 'done')),
        failed = max(0, failed - (OLD.status = 'failed'))
    WHERE id = OLD.batch_id;
END;
