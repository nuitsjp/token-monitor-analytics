-- +goose Up
CREATE TABLE services (
    service_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    official_key TEXT NOT NULL UNIQUE CHECK (length(trim(official_key)) > 0),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE service_identifier_mappings (
    mapping_id TEXT PRIMARY KEY,
    identifier_kind TEXT NOT NULL CHECK (identifier_kind IN ('usage_cost', 'usage_limit')),
    raw_identifier TEXT NOT NULL CHECK (length(raw_identifier) > 0),
    service_id TEXT NOT NULL REFERENCES services(service_id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX service_identifier_mappings_lookup
    ON service_identifier_mappings (identifier_kind, raw_identifier, valid_from);

CREATE TABLE limit_definitions (
    limit_definition_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    cycle_type TEXT NOT NULL CHECK (length(trim(cycle_type)) > 0),
    meaning TEXT NOT NULL CHECK (length(trim(meaning)) > 0),
    unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
    billing_confirmation TEXT NOT NULL CHECK (billing_confirmation IN ('not_applicable', 'unconfirmed', 'confirmed')),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE plans (
    plan_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    is_baseline INTEGER NOT NULL CHECK (is_baseline IN (0, 1)),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX plans_one_baseline_per_service
    ON plans (service_id) WHERE is_baseline = 1;

CREATE TABLE plan_versions (
    plan_version_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(plan_id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    official_source_url TEXT NOT NULL CHECK (length(trim(official_source_url)) > 0),
    created_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX plan_versions_plan_period
    ON plan_versions (plan_id, valid_from);

CREATE TABLE plan_limit_rules (
    plan_limit_rule_id TEXT PRIMARY KEY,
    plan_version_id TEXT NOT NULL REFERENCES plan_versions(plan_version_id),
    limit_definition_id TEXT NOT NULL REFERENCES limit_definitions(limit_definition_id),
    plan_limit REAL,
    limit_multiplier REAL,
    official_source_url TEXT NOT NULL CHECK (length(trim(official_source_url)) > 0),
    created_at TEXT NOT NULL,
    UNIQUE (plan_version_id, limit_definition_id),
    CHECK (plan_limit IS NULL OR plan_limit >= 0),
    CHECK (limit_multiplier IS NULL OR limit_multiplier > 0)
) STRICT;

CREATE TABLE standard_prices (
    standard_price_id TEXT PRIMARY KEY,
    plan_version_id TEXT NOT NULL REFERENCES plan_versions(plan_version_id),
    usd_monthly_per_seat REAL NOT NULL CHECK (usd_monthly_per_seat > 0),
    source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX standard_prices_plan_period
    ON standard_prices (plan_version_id, valid_from);

CREATE TABLE identification_candidates (
    candidate_id TEXT PRIMARY KEY,
    raw_limit_service_identifier TEXT NOT NULL CHECK (length(raw_limit_service_identifier) > 0),
    raw_reported_plan_name TEXT NOT NULL CHECK (length(raw_reported_plan_name) > 0),
    state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed', 'rejected')),
    service_id TEXT REFERENCES services(service_id),
    plan_id TEXT REFERENCES plans(plan_id),
    first_observed_at TEXT,
    last_observed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (last_observed_at IS NULL OR first_observed_at IS NULL OR first_observed_at <= last_observed_at),
    CHECK (
        (state = 'confirmed' AND service_id IS NOT NULL AND plan_id IS NOT NULL)
        OR (state IN ('unconfirmed', 'rejected') AND service_id IS NULL AND plan_id IS NULL)
    )
) STRICT;

CREATE TABLE identification_candidate_observations (
    observation_id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES identification_candidates(candidate_id),
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    hub_account_display TEXT NOT NULL,
    observed_at TEXT NOT NULL
) STRICT;

CREATE INDEX identification_candidate_observations_candidate_time
    ON identification_candidate_observations (candidate_id, observed_at);

-- SQLite has no exclusion constraint. These triggers preserve half-open
-- intervals, so adjacent periods [a,b) and [b,c) are valid while overlap is
-- rejected at the database boundary even when the caller bypasses Go.
-- +goose StatementBegin
CREATE TRIGGER service_identifier_mappings_no_overlap_insert
BEFORE INSERT ON service_identifier_mappings
WHEN EXISTS (
    SELECT 1 FROM service_identifier_mappings old
    WHERE old.identifier_kind = NEW.identifier_kind
      AND old.raw_identifier = NEW.raw_identifier
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'service identifier mapping period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER service_identifier_mappings_no_overlap_update
BEFORE UPDATE OF identifier_kind, raw_identifier, valid_from, valid_to ON service_identifier_mappings
WHEN EXISTS (
    SELECT 1 FROM service_identifier_mappings old
    WHERE old.mapping_id <> NEW.mapping_id
      AND old.identifier_kind = NEW.identifier_kind
      AND old.raw_identifier = NEW.raw_identifier
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'service identifier mapping period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_versions_no_overlap_insert
BEFORE INSERT ON plan_versions
WHEN EXISTS (
    SELECT 1 FROM plan_versions old
    WHERE old.plan_id = NEW.plan_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'plan version period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_versions_no_overlap_update
BEFORE UPDATE OF plan_id, valid_from, valid_to ON plan_versions
WHEN EXISTS (
    SELECT 1 FROM plan_versions old
    WHERE old.plan_version_id <> NEW.plan_version_id
      AND old.plan_id = NEW.plan_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'plan version period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER standard_prices_no_overlap_insert
BEFORE INSERT ON standard_prices
WHEN EXISTS (
    SELECT 1 FROM standard_prices old
    WHERE old.plan_version_id = NEW.plan_version_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'standard price period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER standard_prices_no_overlap_update
BEFORE UPDATE OF plan_version_id, valid_from, valid_to ON standard_prices
WHEN EXISTS (
    SELECT 1 FROM standard_prices old
    WHERE old.standard_price_id <> NEW.standard_price_id
      AND old.plan_version_id = NEW.plan_version_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'standard price period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_limit_rules_service_match_insert
BEFORE INSERT ON plan_limit_rules
WHEN EXISTS (
    SELECT 1
    FROM plan_versions pv
    JOIN plans p ON p.plan_id = pv.plan_id
    JOIN limit_definitions ld ON ld.limit_definition_id = NEW.limit_definition_id
    WHERE pv.plan_version_id = NEW.plan_version_id
      AND p.service_id <> ld.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'plan and limit definition belong to different services');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_limit_rules_service_match_update
BEFORE UPDATE OF plan_version_id, limit_definition_id ON plan_limit_rules
WHEN EXISTS (
    SELECT 1
    FROM plan_versions pv
    JOIN plans p ON p.plan_id = pv.plan_id
    JOIN limit_definitions ld ON ld.limit_definition_id = NEW.limit_definition_id
    WHERE pv.plan_version_id = NEW.plan_version_id
      AND p.service_id <> ld.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'plan and limit definition belong to different services');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER identification_candidates_plan_service_match_insert
BEFORE INSERT ON identification_candidates
WHEN NEW.state = 'confirmed' AND EXISTS (
    SELECT 1
    FROM plans p
    JOIN services s ON s.service_id = NEW.service_id
    WHERE p.plan_id = NEW.plan_id AND p.service_id <> s.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'candidate plan belongs to a different service');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER identification_candidates_plan_service_match_update
BEFORE UPDATE OF service_id, plan_id, state ON identification_candidates
WHEN NEW.state = 'confirmed' AND EXISTS (
    SELECT 1
    FROM plans p
    JOIN services s ON s.service_id = NEW.service_id
    WHERE p.plan_id = NEW.plan_id AND p.service_id <> s.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'candidate plan belongs to a different service');
END;
-- +goose StatementEnd

UPDATE schema_metadata SET schema_version = 5 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 4 WHERE singleton = 1;
DROP TRIGGER identification_candidates_plan_service_match_update;
DROP TRIGGER identification_candidates_plan_service_match_insert;
DROP TRIGGER plan_limit_rules_service_match_update;
DROP TRIGGER plan_limit_rules_service_match_insert;
DROP TRIGGER standard_prices_no_overlap_update;
DROP TRIGGER standard_prices_no_overlap_insert;
DROP TRIGGER plan_versions_no_overlap_update;
DROP TRIGGER plan_versions_no_overlap_insert;
DROP TRIGGER service_identifier_mappings_no_overlap_update;
DROP TRIGGER service_identifier_mappings_no_overlap_insert;
DROP INDEX identification_candidate_observations_candidate_time;
DROP TABLE identification_candidate_observations;
DROP TABLE identification_candidates;
DROP INDEX standard_prices_plan_period;
DROP TABLE standard_prices;
DROP TABLE plan_limit_rules;
DROP INDEX plan_versions_plan_period;
DROP TABLE plan_versions;
DROP INDEX plans_one_baseline_per_service;
DROP TABLE plans;
DROP TABLE limit_definitions;
DROP INDEX service_identifier_mappings_lookup;
DROP TABLE service_identifier_mappings;
DROP TABLE services;
