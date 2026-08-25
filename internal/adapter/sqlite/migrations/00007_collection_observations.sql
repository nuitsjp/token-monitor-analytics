-- +goose Up
CREATE TABLE collection_attempts (
    attempt_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'skipped')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    analytics_interval_seconds INTEGER NOT NULL CHECK (analytics_interval_seconds > 0),
    health_http_status INTEGER,
    stats_http_status INTEGER,
    api_contract TEXT,
    health_snapshot_id TEXT,
    stats_snapshot_id TEXT,
    failure_code TEXT,
    failure_detail TEXT,
    normalization_error_path TEXT
) STRICT;

CREATE INDEX collection_attempts_hub_started
    ON collection_attempts (hub_id, started_at DESC);

CREATE TABLE raw_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES collection_attempts(attempt_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    response_kind TEXT NOT NULL CHECK (response_kind IN ('health', 'stats')),
    received_started_at TEXT NOT NULL,
    received_completed_at TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    api_contract TEXT,
    body BLOB NOT NULL
) STRICT;

CREATE UNIQUE INDEX raw_snapshots_attempt_kind
    ON raw_snapshots (attempt_id, response_kind);

CREATE TABLE usage_cost_observations (
    observation_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    raw_service_identifier TEXT NOT NULL CHECK (length(trim(raw_service_identifier)) > 0),
    usage_updated_at TEXT NOT NULL,
    cost_usd_text TEXT NOT NULL,
    sync_upload_interval_ms INTEGER,
    analytics_interval_seconds INTEGER NOT NULL CHECK (analytics_interval_seconds > 0),
    source_timezone TEXT,
    source_local_date TEXT,
    normalization_generation INTEGER NOT NULL,
    normalization_rule_version TEXT NOT NULL,
    normalization_logic_version TEXT NOT NULL,
    json_path TEXT NOT NULL,
    dedupe_state TEXT NOT NULL CHECK (dedupe_state IN ('canonical', 'duplicate', 'conflict')),
    dedupe_key TEXT NOT NULL,
    value_fingerprint TEXT NOT NULL
) STRICT;

CREATE INDEX usage_cost_observations_lookup
    ON usage_cost_observations (hub_id, device_id, raw_service_identifier, usage_updated_at);

CREATE TABLE usage_limit_observations (
    observation_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES raw_snapshots(snapshot_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    raw_service_identifier TEXT NOT NULL CHECK (length(trim(raw_service_identifier)) > 0),
    account_key TEXT NOT NULL,
    provider_updated_at TEXT NOT NULL,
    window_key TEXT NOT NULL,
    normalized_kind TEXT NOT NULL,
    normalized_metric TEXT NOT NULL,
    normalized_label TEXT NOT NULL,
    plan_label TEXT NOT NULL,
    used_percent REAL,
    resets_at TEXT,
    sync_upload_interval_ms INTEGER,
    limits_refresh_ms INTEGER,
    analytics_interval_seconds INTEGER NOT NULL CHECK (analytics_interval_seconds > 0),
    source_timezone TEXT,
    source_local_date TEXT,
    normalization_generation INTEGER NOT NULL,
    normalization_rule_version TEXT NOT NULL,
    normalization_logic_version TEXT NOT NULL,
    json_path TEXT NOT NULL,
    dedupe_state TEXT NOT NULL CHECK (dedupe_state IN ('canonical', 'duplicate', 'conflict')),
    dedupe_key TEXT NOT NULL,
    value_fingerprint TEXT NOT NULL
) STRICT;

CREATE INDEX usage_limit_observations_lookup
    ON usage_limit_observations (hub_id, device_id, raw_service_identifier, account_key, window_key, provider_updated_at);

UPDATE schema_metadata SET schema_version = 7 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 6 WHERE singleton = 1;
DROP INDEX usage_limit_observations_lookup;
DROP TABLE usage_limit_observations;
DROP INDEX usage_cost_observations_lookup;
DROP TABLE usage_cost_observations;
DROP INDEX raw_snapshots_attempt_kind;
DROP TABLE raw_snapshots;
DROP INDEX collection_attempts_hub_started;
DROP TABLE collection_attempts;
