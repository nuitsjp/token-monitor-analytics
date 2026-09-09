-- Hub registrations are application state.  Secrets remain in the separate
-- hub-secrets file and are addressed here only by an opaque reference.
CREATE TABLE hubs (
 id TEXT PRIMARY KEY NOT NULL,
 label TEXT NOT NULL,
 url TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
 secret_ref TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX hubs_non_archived_url
 ON hubs(url) WHERE status <> 'archived';

-- Immutable labels/URLs keep old history explainable after a Hub is edited or
-- archived.  They are descriptive snapshots and are never used to reconnect.
CREATE TABLE hub_snapshots (
 hub_id TEXT NOT NULL,
 hub_version INTEGER NOT NULL,
 label TEXT NOT NULL,
 url TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
 captured_at TEXT NOT NULL,
 PRIMARY KEY (hub_id, hub_version)
);

-- Contract definitions are calculation settings supplied at startup.  Keep
-- each immutable definition for history descriptions while the active config
-- remains the only source used by the estimator.
CREATE TABLE contract_snapshots (
 contract_id TEXT NOT NULL,
 definition_hash TEXT NOT NULL,
 hub_id TEXT NOT NULL,
 label TEXT NOT NULL,
 definition_json TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 PRIMARY KEY (contract_id, definition_hash)
);
