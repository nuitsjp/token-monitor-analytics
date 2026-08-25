-- +goose Up
CREATE TABLE hubs (
    hub_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    url TEXT NOT NULL,
    collection_enabled INTEGER NOT NULL CHECK (collection_enabled IN (0, 1)),
    collection_interval_seconds INTEGER NOT NULL CHECK (collection_interval_seconds > 0),
    api_contract TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE hub_connection_statuses (
    hub_id TEXT PRIMARY KEY REFERENCES hubs(hub_id),
    state TEXT NOT NULL CHECK (state IN (
        'not_checked', 'connected', 'unreachable', 'timeout', 'tls_error',
        'authentication_failed', 'unsupported_contract', 'invalid_json'
    )),
    checked_at TEXT,
    failure_detail TEXT
) STRICT;

UPDATE schema_metadata SET schema_version = 3 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 2 WHERE singleton = 1;
DROP TABLE hub_connection_statuses;
DROP TABLE hubs;
