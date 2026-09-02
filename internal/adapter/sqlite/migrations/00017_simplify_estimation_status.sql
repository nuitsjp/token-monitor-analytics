-- +goose Up
CREATE TABLE estimation_results_new (
    estimation_result_id TEXT PRIMARY KEY,
    result_set_key TEXT NOT NULL UNIQUE,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    cycle_type TEXT NOT NULL,
    calculation_interval_ids_json TEXT NOT NULL CHECK (json_valid(calculation_interval_ids_json) AND json_type(calculation_interval_ids_json) = 'array'),
    valid_from TEXT NOT NULL,
    valid_to TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('insufficient_observations', 'unidentifiable', 'estimated', 'model_mismatch', 'not_applicable', 'uncomputed')),
    reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json) AND json_type(limits_json) = 'array'),
    observation_point_count INTEGER NOT NULL CHECK (observation_point_count >= 0),
    difference_row_count INTEGER NOT NULL CHECK (difference_row_count >= 0),
    rank INTEGER NOT NULL CHECK (rank >= 0),
    max_time_delta_ns INTEGER NOT NULL CHECK (max_time_delta_ns >= 0),
    calculation_logic_version TEXT NOT NULL CHECK (length(trim(calculation_logic_version)) > 0),
    matching_rule_version TEXT NOT NULL DEFAULT '',
    input_fingerprint TEXT NOT NULL CHECK (length(trim(input_fingerprint)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from < valid_to)
) STRICT;

INSERT INTO estimation_results_new (
    estimation_result_id, result_set_key, service_id, limit_definition_id,
    cycle_type, calculation_interval_ids_json, valid_from, valid_to,
    status, reasons_json, limits_json, observation_point_count,
    difference_row_count, rank, max_time_delta_ns,
    calculation_logic_version, matching_rule_version, input_fingerprint,
    created_at, updated_at
)
SELECT
    estimation_result_id, result_set_key, service_id, limit_definition_id,
    cycle_type, calculation_interval_ids_json, valid_from, valid_to,
    status, reasons_json, limits_json, observation_point_count,
    difference_row_count, rank, max_time_delta_ns,
    calculation_logic_version, matching_rule_version, input_fingerprint,
    created_at, updated_at
FROM estimation_results
WHERE status NOT IN ('provisional', 'verified')
  AND NOT (status = 'model_mismatch' AND reasons_json LIKE '%residual_over_ten_percent%')
  AND calculation_logic_version = 't032-adjacent-l2-rank-nnls-v2';

DROP TABLE estimation_results;

ALTER TABLE estimation_results_new RENAME TO estimation_results;

CREATE INDEX estimation_results_lookup
    ON estimation_results (service_id, limit_definition_id, cycle_type, valid_from, valid_to);

UPDATE schema_metadata SET schema_version = 17 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 16 WHERE singleton = 1;
