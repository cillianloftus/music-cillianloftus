-- Migration 0071: a priority lane in the job queue.
--
-- On 14 Nov a few discographies put 3,400 imports in the queue, a day and
-- a half of work, and an album or artist refreshed by hand waited behind
-- all of them. Now what is asked for directly (a refresh, one import, a
-- push, a backup) goes first: priority 1; bulk work (whole discographies,
-- refreshing the whole library) is 0. Within a priority, oldest first as
-- before. Every job already queued is bulk.

ALTER TABLE job ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- The claim's one seek: the highest priority, then the oldest.
DROP INDEX job_queue;
CREATE INDEX job_queue ON job (status, priority DESC, created_at);
