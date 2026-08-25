-- +goose Up
CREATE TABLE calculation_boundaries (
    calculation_boundary_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    logical_account_id TEXT NOT NULL REFERENCES logical_accounts(logical_account_id),
    usage_limit_source_id TEXT NOT NULL REFERENCES usage_limit_sources(usage_limit_source_id),
    boundary_at TEXT NOT NULL,
    boundary_kind TEXT NOT NULL CHECK (boundary_kind IN ('reset', 'plan_history', 'association', 'completeness', 'hub_switch', 'api_contract', 'unexplained_decrease')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    related_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (usage_limit_source_id, boundary_at, boundary_kind, related_id)
) STRICT;

CREATE INDEX calculation_boundaries_lookup
    ON calculation_boundaries (service_id, logical_account_id, usage_limit_source_id, boundary_at);

CREATE TABLE calculation_intervals (
    calculation_interval_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    logical_account_id TEXT NOT NULL REFERENCES logical_accounts(logical_account_id),
    usage_limit_source_id TEXT NOT NULL REFERENCES usage_limit_sources(usage_limit_source_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    plan_version_id TEXT,
    cycle_type TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('estimable', 'excluded')),
    exclusion_reason TEXT NOT NULL DEFAULT '',
    boundary_ids_json TEXT NOT NULL CHECK (json_valid(boundary_ids_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from < valid_to),
    CHECK ((state = 'excluded' AND length(trim(exclusion_reason)) > 0) OR (state = 'estimable' AND exclusion_reason = '')),
    UNIQUE (usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to)
) STRICT;

CREATE INDEX calculation_intervals_lookup
    ON calculation_intervals (service_id, logical_account_id, valid_from, valid_to, state);

UPDATE schema_metadata SET schema_version = 11 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 10 WHERE singleton = 1;
DROP INDEX calculation_intervals_lookup;
DROP TABLE calculation_intervals;
DROP INDEX calculation_boundaries_lookup;
DROP TABLE calculation_boundaries;
