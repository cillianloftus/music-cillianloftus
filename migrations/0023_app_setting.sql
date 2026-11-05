-- Migration number: 0023
--
-- Small switches the app flips at run time, kept in D1 so every Worker
-- (the cron included) sees the same value at once. First: whether the job
-- queue is paused.
CREATE TABLE app_setting (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
) STRICT;
