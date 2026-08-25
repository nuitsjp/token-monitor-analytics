-- +goose Up
CREATE TABLE estimation_points (
    estimation_point_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    plan_version_id TEXT,
    cycle_type TEXT NOT NULL,
    calculation_interval_id TEXT NOT NULL REFERENCES calculation_intervals(calculation_interval_id),
    calculation_interval_ids_json TEXT NOT NULL CHECK (json_valid(calculation_interval_ids_json)),
    reference_at TEXT NOT NULL,
    shared_cost REAL NOT NULL CHECK (shared_cost = shared_cost AND shared_cost >= 0),
    utilization_json TEXT NOT NULL CHECK (json_valid(utilization_json) AND json_type(utilization_json) = 'array'),
    limit_series_ids_json TEXT NOT NULL CHECK (json_valid(limit_series_ids_json)),
    limit_series_logical_account_ids_json TEXT NOT NULL CHECK (json_valid(limit_series_logical_account_ids_json) AND json_type(limit_series_logical_account_ids_json) = 'array'),
    limit_series_plan_version_ids_json TEXT NOT NULL CHECK (json_valid(limit_series_plan_version_ids_json) AND json_type(limit_series_plan_version_ids_json) = 'array'),
    limit_series_calculation_interval_ids_json TEXT NOT NULL CHECK (json_valid(limit_series_calculation_interval_ids_json) AND json_type(limit_series_calculation_interval_ids_json) = 'array'),
    cost_source_ids_json TEXT NOT NULL CHECK (json_valid(cost_source_ids_json)),
    association_ids_json TEXT NOT NULL CHECK (json_valid(association_ids_json)),
    completeness_ids_json TEXT NOT NULL CHECK (json_valid(completeness_ids_json)),
    matching_rule_version TEXT NOT NULL CHECK (length(trim(matching_rule_version)) > 0),
    calculation_logic_version TEXT NOT NULL CHECK (length(trim(calculation_logic_version)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (calculation_interval_id, reference_at, matching_rule_version, calculation_logic_version)
) STRICT;

CREATE INDEX estimation_points_lookup
    ON estimation_points (service_id, limit_definition_id, calculation_interval_id, reference_at);

CREATE TABLE matched_observations (
    matched_observation_id TEXT PRIMARY KEY,
    estimation_point_id TEXT NOT NULL REFERENCES estimation_points(estimation_point_id) ON DELETE CASCADE,
    observation_role TEXT NOT NULL CHECK (observation_role IN ('limit', 'cost')),
    source_id TEXT NOT NULL,
    logical_account_id TEXT,
    observation_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    time_delta_ns INTEGER NOT NULL CHECK (time_delta_ns >= 0),
    tolerance_ns INTEGER NOT NULL CHECK (tolerance_ns >= 0),
    analytics_interval_seconds INTEGER NOT NULL CHECK (analytics_interval_seconds > 0),
    sync_upload_interval_ms INTEGER,
    limits_refresh_ms INTEGER,
    normalization_generation INTEGER NOT NULL,
    normalization_rule_version TEXT NOT NULL,
    normalization_logic_version TEXT NOT NULL,
    UNIQUE (estimation_point_id, observation_role, source_id, observation_id, normalization_generation)
) STRICT;

CREATE INDEX matched_observations_lookup
    ON matched_observations (observation_id, observation_role, observed_at);

UPDATE schema_metadata SET schema_version = 12 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 11 WHERE singleton = 1;
DROP INDEX matched_observations_lookup;
DROP TABLE matched_observations;
DROP INDEX estimation_points_lookup;
DROP TABLE estimation_points;
