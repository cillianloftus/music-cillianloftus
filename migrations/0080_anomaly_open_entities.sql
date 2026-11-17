-- Open anomalies by either side, for the merges that close every open
-- anomaly naming the song, album or artist merged away (src/lib/merge.ts,
-- one lookup a side). With only anomaly_open_once, led by kind, each merge
-- read the whole table: 2.7 million rows on 16 Nov, 3,500 a merge.
-- Partial, as the merges only touch open ones.
CREATE INDEX anomaly_open_a ON anomaly (entity_type, entity_a) WHERE status = 'open';
CREATE INDEX anomaly_open_b ON anomaly (entity_type, entity_b) WHERE status = 'open';
