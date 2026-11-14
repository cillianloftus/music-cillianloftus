-- Migration 0070: job counts kept, not counted.
--
-- The import tray shows the whole queue's progress on every device (how
-- many to go, how fast, what is importing now), so it asks often. Counting
-- the job table each time read every row (10,000 by 14 Nov, 3,400 of them
-- waiting). Now triggers keep one number per status in app_setting
-- ('jobs_n_queued', 'jobs_n_running', 'jobs_n_done', 'jobs_n_failed'), as
-- 0049 does for versions, and a nightly task sets them from a real count
-- in case anything (a restore) moved the table without them.
--
-- The rate comes from the last few finished jobs, read through a new
-- index on finished_at rather than by scanning.

INSERT INTO app_setting (key, value)
SELECT 'jobs_n_' || s.status, CAST(coalesce((SELECT count(*) FROM job j WHERE j.status = s.status), 0) AS TEXT)
FROM (SELECT 'queued' AS status UNION ALL SELECT 'running' UNION ALL SELECT 'done' UNION ALL SELECT 'failed') s
WHERE true
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

CREATE TRIGGER job_count_insert AFTER INSERT ON job
BEGIN
    INSERT INTO app_setting (key, value) VALUES ('jobs_n_' || NEW.status, '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;

CREATE TRIGGER job_count_update AFTER UPDATE OF status ON job WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE app_setting SET value = max(0, CAST(value AS INTEGER) - 1) WHERE key = 'jobs_n_' || OLD.status;
    INSERT INTO app_setting (key, value) VALUES ('jobs_n_' || NEW.status, '1')
    ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
END;

CREATE TRIGGER job_count_delete AFTER DELETE ON job
BEGIN
    UPDATE app_setting SET value = max(0, CAST(value AS INTEGER) - 1) WHERE key = 'jobs_n_' || OLD.status;
END;

CREATE INDEX job_finished ON job (finished_at) WHERE finished_at IS NOT NULL;
