-- Precise credits from MusicBrainz find their role by label as well as by
-- id ("Recording engineer" from an import whose id differs). Without an
-- index each lookup read all of credit_role, two or three times for each
-- credit, about 5,500 rows for an album.
CREATE INDEX credit_role_label ON credit_role (label COLLATE NOCASE);
