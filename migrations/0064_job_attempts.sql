-- How many times a job has been started. A job whose Worker is cut off
-- (out of memory, out of time) records no error; it stays 'running' and
-- was taken up again every fifteen minutes for ever. The daily backup did
-- that for two days on 10-11 Nov 2026, reading the whole database each
-- time. Now the third time it is found cut off, it fails instead.
ALTER TABLE job ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
