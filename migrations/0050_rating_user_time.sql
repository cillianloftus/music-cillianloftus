-- Migration 0050: a user's ratings by time.
--
-- The library cache's stamp asks for a user's latest rating before every
-- cached read. Through the unique key (user, entity type, entity, time) that
-- meant reading every one of their ratings (565 rows now, more with every
-- rating); with time second in an index it is one seek. The diary and
-- "recently rated" read ratings newest first too.
--
-- A migration that rebuilds rating (as 0042 and 0045 did) must recreate it.

CREATE INDEX rating_user_time ON rating (user_id, rated_at);
