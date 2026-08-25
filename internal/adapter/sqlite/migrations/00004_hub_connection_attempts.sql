-- +goose Up
CREATE TABLE hub_connection_attempts (
    attempt_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    checked_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'connected', 'unreachable', 'timeout', 'tls_error',
        'authentication_failed', 'unsupported_contract', 'invalid_json'
    )),
    api_contract TEXT,
    failure_detail TEXT
) STRICT;

CREATE INDEX hub_connection_attempts_hub_time
    ON hub_connection_attempts (hub_id, checked_at DESC);

UPDATE schema_metadata SET schema_version = 4 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 3 WHERE singleton = 1;
DROP INDEX hub_connection_attempts_hub_time;
DROP TABLE hub_connection_attempts;
