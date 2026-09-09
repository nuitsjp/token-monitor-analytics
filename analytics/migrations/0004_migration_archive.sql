-- A cutover archive is descriptive history, not a reconnectable Hub row.
-- Archived rows therefore carry no URL or Secret reference.  Existing
-- non-archived rows keep their values and all older migration SQL remains
-- immutable.
DROP INDEX IF EXISTS hubs_non_archived_url;

ALTER TABLE hubs RENAME TO hubs_before_archive;

CREATE TABLE hubs (
 id TEXT PRIMARY KEY NOT NULL,
 label TEXT NOT NULL,
 url TEXT,
 status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
 secret_ref TEXT,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK (
   (status = 'archived' AND url IS NULL AND secret_ref IS NULL) OR
   (status <> 'archived' AND url IS NOT NULL AND secret_ref IS NOT NULL)
 )
);

INSERT INTO hubs(id,label,url,status,secret_ref,version,created_at,updated_at)
SELECT id,label,
       CASE WHEN status = 'archived' THEN NULL ELSE url END,
       status,
       CASE WHEN status = 'archived' THEN NULL ELSE secret_ref END,
       version,created_at,updated_at
  FROM hubs_before_archive;

DROP TABLE hubs_before_archive;

CREATE UNIQUE INDEX hubs_non_archived_url
 ON hubs(url) WHERE status <> 'archived';
