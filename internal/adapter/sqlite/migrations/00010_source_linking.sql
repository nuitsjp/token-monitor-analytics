-- +goose Up
CREATE TABLE usage_cost_sources (
    usage_cost_source_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    raw_service_identifier TEXT NOT NULL CHECK (length(trim(raw_service_identifier)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (hub_id, device_id, raw_service_identifier)
) STRICT;

CREATE INDEX usage_cost_sources_lookup
    ON usage_cost_sources (hub_id, device_id, raw_service_identifier);

CREATE TABLE usage_limit_sources (
    usage_limit_source_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    device_id TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
    account_key TEXT NOT NULL,
    raw_service_identifier TEXT NOT NULL CHECK (length(trim(raw_service_identifier)) > 0),
    window_key TEXT NOT NULL CHECK (length(trim(window_key)) > 0),
    normalized_kind TEXT NOT NULL,
    normalized_metric TEXT NOT NULL,
    normalized_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (hub_id, device_id, raw_service_identifier, account_key, window_key)
) STRICT;

CREATE INDEX usage_limit_sources_lookup
    ON usage_limit_sources (hub_id, device_id, raw_service_identifier, account_key, window_key);

CREATE TABLE usage_cost_source_account_links (
    usage_cost_association_id TEXT PRIMARY KEY,
    usage_cost_source_id TEXT NOT NULL REFERENCES usage_cost_sources(usage_cost_source_id),
    logical_account_id TEXT NOT NULL REFERENCES logical_accounts(logical_account_id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX usage_cost_source_account_links_lookup
    ON usage_cost_source_account_links (usage_cost_source_id, valid_from, valid_to);

CREATE TABLE usage_limit_source_links (
    usage_limit_association_id TEXT PRIMARY KEY,
    usage_limit_source_id TEXT NOT NULL REFERENCES usage_limit_sources(usage_limit_source_id),
    logical_account_id TEXT NOT NULL REFERENCES logical_accounts(logical_account_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX usage_limit_source_links_lookup
    ON usage_limit_source_links (usage_limit_source_id, valid_from, valid_to);

CREATE TABLE usage_cost_source_completeness (
    completeness_id TEXT PRIMARY KEY,
    usage_cost_source_id TEXT NOT NULL REFERENCES usage_cost_sources(usage_cost_source_id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed')),
    logical_account_ids_json TEXT NOT NULL CHECK (json_valid(logical_account_ids_json)),
    excluded_activity_json TEXT NOT NULL CHECK (json_valid(excluded_activity_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to),
    CHECK (state <> 'confirmed' OR excluded_activity_json = '[]')
) STRICT;

CREATE INDEX usage_cost_source_completeness_lookup
    ON usage_cost_source_completeness (usage_cost_source_id, valid_from, valid_to);

CREATE TABLE hub_switches (
    hub_switch_id TEXT PRIMARY KEY,
    old_hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    old_device_id TEXT NOT NULL CHECK (length(trim(old_device_id)) > 0),
    new_hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    new_device_id TEXT NOT NULL CHECK (length(trim(new_device_id)) > 0),
    collection_device_id TEXT NOT NULL CHECK (length(trim(collection_device_id)) > 0),
    switched_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (old_hub_id <> new_hub_id OR old_device_id <> new_device_id)
) STRICT;

CREATE INDEX hub_switches_time
    ON hub_switches (switched_at, hub_switch_id);

-- SQLite has no exclusion constraint. These triggers preserve half-open
-- periods, allowing [a,b) next to [b,c) while rejecting an overlap.
-- +goose StatementBegin
CREATE TRIGGER usage_cost_source_account_links_no_overlap_insert
BEFORE INSERT ON usage_cost_source_account_links
WHEN EXISTS (
    SELECT 1 FROM usage_cost_source_account_links old
    WHERE old.usage_cost_source_id = NEW.usage_cost_source_id
      AND old.logical_account_id = NEW.logical_account_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage cost association period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER usage_cost_source_account_links_no_overlap_update
BEFORE UPDATE OF usage_cost_source_id, logical_account_id, valid_from, valid_to ON usage_cost_source_account_links
WHEN EXISTS (
    SELECT 1 FROM usage_cost_source_account_links old
    WHERE old.usage_cost_association_id <> NEW.usage_cost_association_id
      AND old.usage_cost_source_id = NEW.usage_cost_source_id
      AND old.logical_account_id = NEW.logical_account_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage cost association period overlaps');
END;
-- +goose StatementEnd

-- One source can have many accounts over time, but only one relation at a
-- given instant for a limit source.
-- +goose StatementBegin
CREATE TRIGGER usage_limit_source_links_no_overlap_insert
BEFORE INSERT ON usage_limit_source_links
WHEN EXISTS (
    SELECT 1 FROM usage_limit_source_links old
    WHERE old.usage_limit_source_id = NEW.usage_limit_source_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage limit association period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER usage_limit_source_links_no_overlap_update
BEFORE UPDATE OF usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to ON usage_limit_source_links
WHEN EXISTS (
    SELECT 1 FROM usage_limit_source_links old
    WHERE old.usage_limit_association_id <> NEW.usage_limit_association_id
      AND old.usage_limit_source_id = NEW.usage_limit_source_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage limit association period overlaps');
END;
-- +goose StatementEnd

-- Completeness is a partition of a source timeline, not a set of overlapping
-- assertions.
-- +goose StatementBegin
CREATE TRIGGER usage_cost_source_completeness_no_overlap_insert
BEFORE INSERT ON usage_cost_source_completeness
WHEN EXISTS (
    SELECT 1 FROM usage_cost_source_completeness old
    WHERE old.usage_cost_source_id = NEW.usage_cost_source_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage cost source completeness period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER usage_cost_source_completeness_no_overlap_update
BEFORE UPDATE OF usage_cost_source_id, valid_from, valid_to ON usage_cost_source_completeness
WHEN EXISTS (
    SELECT 1 FROM usage_cost_source_completeness old
    WHERE old.completeness_id <> NEW.completeness_id
      AND old.usage_cost_source_id = NEW.usage_cost_source_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'usage cost source completeness period overlaps');
END;
-- +goose StatementEnd

UPDATE schema_metadata SET schema_version = 10 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 9 WHERE singleton = 1;
DROP TRIGGER usage_cost_source_completeness_no_overlap_update;
DROP TRIGGER usage_cost_source_completeness_no_overlap_insert;
DROP TRIGGER usage_limit_source_links_no_overlap_update;
DROP TRIGGER usage_limit_source_links_no_overlap_insert;
DROP TRIGGER usage_cost_source_account_links_no_overlap_update;
DROP TRIGGER usage_cost_source_account_links_no_overlap_insert;
DROP INDEX hub_switches_time;
DROP TABLE hub_switches;
DROP INDEX usage_cost_source_completeness_lookup;
DROP TABLE usage_cost_source_completeness;
DROP INDEX usage_limit_source_links_lookup;
DROP TABLE usage_limit_source_links;
DROP INDEX usage_cost_source_account_links_lookup;
DROP TABLE usage_cost_source_account_links;
DROP INDEX usage_limit_sources_lookup;
DROP TABLE usage_limit_sources;
DROP INDEX usage_cost_sources_lookup;
DROP TABLE usage_cost_sources;
