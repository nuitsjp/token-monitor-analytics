-- +goose Up
CREATE TABLE judgments (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
) STRICT;

CREATE TABLE configuration_audits (
    sequence INTEGER PRIMARY KEY,
    audit_id TEXT NOT NULL UNIQUE,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT
) STRICT;

-- +goose StatementBegin
CREATE TRIGGER configuration_audits_no_update
BEFORE UPDATE ON configuration_audits
BEGIN
    SELECT RAISE(ABORT, 'configuration audits are append-only');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER configuration_audits_no_delete
BEFORE DELETE ON configuration_audits
BEGIN
    SELECT RAISE(ABORT, 'configuration audits are append-only');
END;
-- +goose StatementEnd

CREATE TABLE recalculation_requests (
    request_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL UNIQUE REFERENCES configuration_audits(audit_id),
    requested_at TEXT NOT NULL,
    interval_start TEXT NOT NULL,
    interval_end TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
    last_error TEXT,
    CHECK (interval_start < interval_end)
) STRICT;

UPDATE schema_metadata SET schema_version = 2 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 1 WHERE singleton = 1;
DROP TABLE recalculation_requests;
DROP TRIGGER configuration_audits_no_delete;
DROP TRIGGER configuration_audits_no_update;
DROP TABLE configuration_audits;
DROP TABLE judgments;
