-- +goose Up
CREATE TABLE usage_analysis_observations (
    usage_observation_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    raw_service_identifier TEXT NOT NULL CHECK (length(trim(raw_service_identifier)) > 0),
    usage_updated_at TEXT NOT NULL,
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    api_cost_usd_text TEXT,
    model_tokens_json TEXT NOT NULL CHECK (json_valid(model_tokens_json) AND json_type(model_tokens_json) = 'object'),
    model_costs_json TEXT NOT NULL CHECK (json_valid(model_costs_json) AND json_type(model_costs_json) = 'object'),
    source_timezone TEXT,
    source_local_date TEXT,
    normalization_generation INTEGER NOT NULL CHECK (normalization_generation > 0),
    normalization_rule_version TEXT NOT NULL,
    normalization_logic_version TEXT NOT NULL,
    json_path TEXT NOT NULL,
    dedupe_state TEXT NOT NULL CHECK (dedupe_state IN ('canonical', 'duplicate', 'conflict')),
    dedupe_key TEXT NOT NULL,
    value_fingerprint TEXT NOT NULL
) STRICT;

CREATE INDEX usage_analysis_observations_lookup
    ON usage_analysis_observations (hub_id, device_id, raw_service_identifier, usage_updated_at);

CREATE INDEX usage_analysis_observations_period
    ON usage_analysis_observations (usage_updated_at, dedupe_state);

CREATE TABLE usage_period_observations (
    period_observation_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    period_kind TEXT NOT NULL CHECK (period_kind IN ('day', 'month')),
    period_key TEXT NOT NULL CHECK (length(trim(period_key)) > 0),
    period_ends_at TEXT NOT NULL,
    usage_updated_at TEXT NOT NULL,
    source_timezone TEXT NOT NULL CHECK (length(trim(source_timezone)) > 0),
    token_count INTEGER NOT NULL CHECK (token_count >= 0),
    api_cost_usd_text TEXT,
    tool_tokens_json TEXT NOT NULL CHECK (json_valid(tool_tokens_json) AND json_type(tool_tokens_json) = 'object'),
    tool_costs_json TEXT NOT NULL CHECK (json_valid(tool_costs_json) AND json_type(tool_costs_json) = 'object'),
    model_tokens_json TEXT NOT NULL CHECK (json_valid(model_tokens_json) AND json_type(model_tokens_json) = 'object'),
    model_costs_json TEXT NOT NULL CHECK (json_valid(model_costs_json) AND json_type(model_costs_json) = 'object'),
    tool_model_tokens_json TEXT NOT NULL CHECK (json_valid(tool_model_tokens_json) AND json_type(tool_model_tokens_json) = 'object'),
    tool_model_costs_json TEXT NOT NULL CHECK (json_valid(tool_model_costs_json) AND json_type(tool_model_costs_json) = 'object'),
    normalization_generation INTEGER NOT NULL CHECK (normalization_generation > 0),
    normalization_rule_version TEXT NOT NULL,
    normalization_logic_version TEXT NOT NULL,
    json_path TEXT NOT NULL,
    dedupe_state TEXT NOT NULL CHECK (dedupe_state IN ('canonical', 'conflict')),
    dedupe_key TEXT NOT NULL,
    value_fingerprint TEXT NOT NULL
) STRICT;

CREATE INDEX usage_period_observations_lookup
    ON usage_period_observations (hub_id, device_id, period_kind, period_key, usage_updated_at);

CREATE UNIQUE INDEX usage_period_observations_exact_value
    ON usage_period_observations (hub_id, dedupe_key, normalization_generation, value_fingerprint);

CREATE TABLE usage_limit_amount_observations (
    observation_id TEXT PRIMARY KEY REFERENCES usage_limit_observations(observation_id) ON DELETE CASCADE,
    used_text TEXT,
    limit_text TEXT,
    remaining_text TEXT,
    currency TEXT CHECK (currency IS NULL OR (length(currency) BETWEEN 1 AND 8 AND currency = upper(currency)))
) STRICT;

UPDATE schema_metadata SET schema_version = 14 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 13 WHERE singleton = 1;
DROP TABLE usage_limit_amount_observations;
DROP INDEX usage_period_observations_exact_value;
DROP INDEX usage_period_observations_lookup;
DROP TABLE usage_period_observations;
DROP INDEX usage_analysis_observations_period;
DROP INDEX usage_analysis_observations_lookup;
DROP TABLE usage_analysis_observations;
