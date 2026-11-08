-- Migration number: 0038
--
-- Indexes for the queries that read the most (wrangler d1 insights, 8 Nov):
-- counting the credits of a role scanned every credit, once per role.
CREATE INDEX artist_credit_role ON artist_credit (role);
