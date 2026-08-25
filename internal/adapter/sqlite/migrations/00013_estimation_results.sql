-- +goose Up
ALTER TABLE recalculation_requests ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object');
ALTER TABLE recalculation_requests ADD COLUMN claimed_by TEXT;
ALTER TABLE recalculation_requests ADD COLUMN claimed_at TEXT;

CREATE INDEX recalculation_requests_pending
    ON recalculation_requests (state, requested_at, request_id);

CREATE TABLE estimation_results (
    estimation_result_id TEXT PRIMARY KEY,
    result_set_key TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    cycle_type TEXT NOT NULL,
    calculation_interval_ids_json TEXT NOT NULL CHECK (json_valid(calculation_interval_ids_json) AND json_type(calculation_interval_ids_json) = 'array'),
    valid_from TEXT NOT NULL,
    valid_to TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('insufficient_observations', 'unidentifiable', 'provisional', 'verified', 'model_mismatch', 'not_applicable', 'uncomputed')),
    reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json) AND json_type(limits_json) = 'array'),
    observation_point_count INTEGER NOT NULL CHECK (observation_point_count >= 0),
    difference_row_count INTEGER NOT NULL CHECK (difference_row_count >= 0),
    rank INTEGER NOT NULL CHECK (rank >= 0),
    absolute_error_ratio REAL NOT NULL CHECK (absolute_error_ratio = absolute_error_ratio AND absolute_error_ratio >= 0),
    max_time_delta_ns INTEGER NOT NULL CHECK (max_time_delta_ns >= 0),
    calculation_logic_version TEXT NOT NULL CHECK (length(trim(calculation_logic_version)) > 0),
    matching_rule_version TEXT NOT NULL DEFAULT '',
    input_fingerprint TEXT NOT NULL CHECK (length(trim(input_fingerprint)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from < valid_to)
) STRICT;

CREATE INDEX estimation_results_lookup
    ON estimation_results (service_id, limit_definition_id, cycle_type, valid_from, valid_to);

CREATE TABLE estimation_result_series (
    estimation_result_series_id TEXT PRIMARY KEY,
    estimation_result_id TEXT NOT NULL REFERENCES estimation_results(estimation_result_id) ON DELETE CASCADE,
    usage_limit_source_id TEXT NOT NULL,
    logical_account_id TEXT NOT NULL,
    plan_version_id TEXT NOT NULL,
    calculation_interval_id TEXT NOT NULL DEFAULT '',
    multiplier REAL CHECK (multiplier IS NULL OR (multiplier = multiplier AND multiplier > 0)),
    estimated_limit REAL CHECK (estimated_limit IS NULL OR (estimated_limit = estimated_limit AND estimated_limit >= 0)),
    plan_limit_rule_id TEXT NOT NULL DEFAULT '',
    plan_limit_rule_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(plan_limit_rule_ids_json) AND json_type(plan_limit_rule_ids_json) = 'array'),
    UNIQUE (estimation_result_id, usage_limit_source_id, logical_account_id, plan_version_id)
) STRICT;

CREATE INDEX estimation_result_series_fallback
    ON estimation_result_series (logical_account_id, plan_version_id, estimation_result_id);

CREATE TABLE estimation_result_difference_rows (
    estimation_result_difference_row_id TEXT PRIMARY KEY,
    estimation_result_id TEXT NOT NULL REFERENCES estimation_results(estimation_result_id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL CHECK (row_index >= 0),
    start_point_id TEXT NOT NULL,
    end_point_id TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    coefficients_json TEXT NOT NULL CHECK (json_valid(coefficients_json) AND json_type(coefficients_json) = 'array'),
    cost REAL NOT NULL CHECK (cost = cost),
    accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
    exclusion_reason TEXT NOT NULL DEFAULT '',
    UNIQUE (estimation_result_id, row_index)
) STRICT;

CREATE TABLE estimation_result_evidence (
    estimation_result_evidence_id TEXT PRIMARY KEY,
    estimation_result_id TEXT NOT NULL REFERENCES estimation_results(estimation_result_id) ON DELETE CASCADE,
    evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('point', 'matched_observation', 'snapshot', 'association', 'completeness', 'plan_history')),
    point_id TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    observation_id TEXT NOT NULL DEFAULT '',
    snapshot_id TEXT NOT NULL DEFAULT '',
    association_id TEXT NOT NULL DEFAULT '',
    completeness_id TEXT NOT NULL DEFAULT '',
    plan_history_id TEXT NOT NULL DEFAULT '',
    logical_account_id TEXT NOT NULL DEFAULT '',
    plan_version_id TEXT NOT NULL DEFAULT '',
    observed_at TEXT,
    time_delta_ns INTEGER NOT NULL DEFAULT 0 CHECK (time_delta_ns >= 0),
    normalization_generation INTEGER NOT NULL DEFAULT 0 CHECK (normalization_generation >= 0),
    normalization_rule_version TEXT NOT NULL DEFAULT '',
    normalization_logic_version TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
    UNIQUE (estimation_result_id, evidence_kind, point_id, source_id, observation_id, snapshot_id, association_id, completeness_id, plan_history_id)
) STRICT;

UPDATE schema_metadata SET schema_version = 13 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 12 WHERE singleton = 1;
DROP TABLE estimation_result_evidence;
DROP TABLE estimation_result_difference_rows;
DROP INDEX estimation_result_series_fallback;
DROP TABLE estimation_result_series;
DROP INDEX estimation_results_lookup;
DROP TABLE estimation_results;
DROP INDEX recalculation_requests_pending;
-- SQLite cannot drop columns on all supported versions. Recreate the request
-- table only during an explicit down migration.
CREATE TABLE recalculation_requests_old (
    request_id TEXT PRIMARY KEY,
    audit_id TEXT NOT NULL UNIQUE REFERENCES configuration_audits(audit_id),
    requested_at TEXT NOT NULL,
    interval_start TEXT NOT NULL,
    interval_end TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
    last_error TEXT,
    CHECK (interval_start < interval_end)
) STRICT;
INSERT INTO recalculation_requests_old (request_id, audit_id, requested_at, interval_start, interval_end, state, last_error)
SELECT request_id, audit_id, requested_at, interval_start, interval_end, state, last_error FROM recalculation_requests;
DROP TABLE recalculation_requests;
ALTER TABLE recalculation_requests_old RENAME TO recalculation_requests;
