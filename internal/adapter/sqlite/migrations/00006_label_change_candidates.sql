-- +goose Up
CREATE TABLE limit_label_change_candidates (
    candidate_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_record_key TEXT NOT NULL CHECK (length(trim(device_record_key)) > 0),
    hub_account_key TEXT NOT NULL,
    raw_limit_service_identifier TEXT NOT NULL CHECK (length(raw_limit_service_identifier) > 0),
    normalized_kind TEXT NOT NULL CHECK (length(trim(normalized_kind)) > 0),
    normalized_metric TEXT NOT NULL CHECK (length(trim(normalized_metric)) > 0),
    old_label TEXT NOT NULL,
    new_label TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed_same_limit', 'confirmed_different_limit', 'rejected')),
    limit_definition_id TEXT REFERENCES limit_definitions(limit_definition_id),
    first_observed_at TEXT,
    last_observed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (old_label <> new_label),
    CHECK (last_observed_at IS NULL OR first_observed_at IS NULL OR first_observed_at <= last_observed_at),
    CHECK (
        (state = 'confirmed_same_limit' AND limit_definition_id IS NOT NULL)
        OR (state <> 'confirmed_same_limit' AND limit_definition_id IS NULL)
    )
) STRICT;

CREATE INDEX limit_label_change_candidates_lookup
    ON limit_label_change_candidates (hub_id, device_record_key, hub_account_key, raw_limit_service_identifier, normalized_kind, normalized_metric);

CREATE TABLE limit_label_change_windows (
    window_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES limit_label_change_candidates(candidate_id),
    window_key TEXT NOT NULL,
    label TEXT NOT NULL,
    observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX limit_label_change_windows_candidate_time
    ON limit_label_change_windows (candidate_id, observed_at, window_id);

UPDATE schema_metadata SET schema_version = 6 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 5 WHERE singleton = 1;
DROP INDEX limit_label_change_windows_candidate_time;
DROP TABLE limit_label_change_windows;
DROP INDEX limit_label_change_candidates_lookup;
DROP TABLE limit_label_change_candidates;
