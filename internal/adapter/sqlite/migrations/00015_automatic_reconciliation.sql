-- +goose Up
CREATE TABLE catalog_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    catalog_revision TEXT NOT NULL CHECK (length(trim(catalog_revision)) > 0),
    applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE catalog_bindings (
    binding_id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('service', 'service_identifier_mapping', 'plan', 'plan_version', 'limit_definition')),
    catalog_key TEXT NOT NULL CHECK (length(trim(catalog_key)) > 0),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
    catalog_revision TEXT NOT NULL CHECK (length(trim(catalog_revision)) > 0),
    management_mode TEXT NOT NULL CHECK (management_mode IN ('catalog', 'observed', 'user')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (entity_type, catalog_key)
) STRICT;

CREATE TABLE observed_entitlements (
    entitlement_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    service_id TEXT NOT NULL REFERENCES services(service_id),
    account_key TEXT NOT NULL CHECK (length(trim(account_key)) > 0),
    reported_plan_name TEXT NOT NULL,
    evidence_source TEXT NOT NULL CHECK (evidence_source IN ('plan_label', 'codex_account_label', 'subscription')),
    state TEXT NOT NULL CHECK (state IN ('unresolved', 'resolved')),
    plan_id TEXT REFERENCES plans(plan_id),
    first_observed_at TEXT NOT NULL,
    last_observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (hub_id, service_id, account_key, reported_plan_name, evidence_source),
    CHECK (first_observed_at <= last_observed_at),
    CHECK ((state = 'resolved' AND plan_id IS NOT NULL) OR (state = 'unresolved' AND plan_id IS NULL))
) STRICT;

CREATE INDEX observed_entitlements_account
    ON observed_entitlements (hub_id, service_id, account_key, state);

CREATE TABLE normalization_runs (
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id) ON DELETE CASCADE,
    normalization_generation INTEGER NOT NULL CHECK (normalization_generation > 0),
    rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
    logic_version TEXT NOT NULL CHECK (length(trim(logic_version)) > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_detail TEXT,
    PRIMARY KEY (snapshot_id, normalization_generation)
) STRICT;

CREATE INDEX normalization_runs_active
    ON normalization_runs (snapshot_id, state, normalization_generation);

UPDATE schema_metadata SET schema_version = 15 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 14 WHERE singleton = 1;
DROP INDEX normalization_runs_active;
DROP TABLE normalization_runs;
DROP INDEX observed_entitlements_account;
DROP TABLE observed_entitlements;
DROP TABLE catalog_bindings;
DROP TABLE catalog_state;
