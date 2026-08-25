-- +goose Up
--
-- A Hub account is an observation-side identity.  It is intentionally kept
-- separate from a logical account: equal account keys from different Hubs
-- are therefore candidates, never an automatic merge.
CREATE TABLE logical_accounts (
    logical_account_id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL REFERENCES services(service_id),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX logical_accounts_service_state
    ON logical_accounts (service_id, archived_at, display_name, logical_account_id);

CREATE TABLE hub_account_candidates (
    hub_account_candidate_id TEXT PRIMARY KEY,
    hub_id TEXT NOT NULL REFERENCES hubs(hub_id),
    service_id TEXT NOT NULL REFERENCES services(service_id),
    account_key TEXT NOT NULL CHECK (length(trim(account_key)) > 0),
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    workspace_name TEXT NOT NULL DEFAULT '',
    device_name TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'associated', 'rejected', 'archived_reconfirmation')),
    logical_account_id TEXT REFERENCES logical_accounts(logical_account_id),
    first_observed_at TEXT,
    last_observed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (hub_id, service_id, account_key),
    CHECK (last_observed_at IS NULL OR first_observed_at IS NULL OR first_observed_at <= last_observed_at),
    CHECK (
        (state IN ('associated', 'archived_reconfirmation') AND logical_account_id IS NOT NULL)
        OR (state IN ('unconfirmed', 'rejected') AND logical_account_id IS NULL)
    )
) STRICT;

CREATE INDEX hub_account_candidates_lookup
    ON hub_account_candidates (hub_id, service_id, account_key, state);

CREATE INDEX hub_account_candidates_logical
    ON hub_account_candidates (logical_account_id, state);

CREATE TABLE plan_histories (
    plan_history_id TEXT PRIMARY KEY,
    logical_account_id TEXT NOT NULL REFERENCES logical_accounts(logical_account_id),
    plan_version_id TEXT NOT NULL REFERENCES plan_versions(plan_version_id),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_to IS NULL OR valid_from < valid_to)
) STRICT;

CREATE INDEX plan_histories_account_period
    ON plan_histories (logical_account_id, valid_from, plan_history_id);

-- SQLite has no exclusion constraints.  These triggers preserve half-open
-- intervals, allowing [a,b) next to [b,c) while rejecting an overlap.
-- +goose StatementBegin
CREATE TRIGGER hub_account_candidates_service_match_insert
BEFORE INSERT ON hub_account_candidates
WHEN NEW.logical_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM logical_accounts la
    WHERE la.logical_account_id = NEW.logical_account_id
      AND la.service_id <> NEW.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'Hub account candidate and logical account belong to different services');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER hub_account_candidates_service_match_update
BEFORE UPDATE OF service_id, logical_account_id ON hub_account_candidates
WHEN NEW.logical_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM logical_accounts la
    WHERE la.logical_account_id = NEW.logical_account_id
      AND la.service_id <> NEW.service_id
)
BEGIN
    SELECT RAISE(ABORT, 'Hub account candidate and logical account belong to different services');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_histories_no_overlap_insert
BEFORE INSERT ON plan_histories
WHEN EXISTS (
    SELECT 1 FROM plan_histories old
    WHERE old.logical_account_id = NEW.logical_account_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'plan history period overlaps');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_histories_no_overlap_update
BEFORE UPDATE OF logical_account_id, valid_from, valid_to ON plan_histories
WHEN EXISTS (
    SELECT 1 FROM plan_histories old
    WHERE old.plan_history_id <> NEW.plan_history_id
      AND old.logical_account_id = NEW.logical_account_id
      AND (old.valid_to IS NULL OR NEW.valid_from < old.valid_to)
      AND (NEW.valid_to IS NULL OR old.valid_from < NEW.valid_to)
)
BEGIN
    SELECT RAISE(ABORT, 'plan history period overlaps');
END;
-- +goose StatementEnd

-- A history row must be wholly contained in the referenced plan version.
-- +goose StatementBegin
CREATE TRIGGER plan_histories_plan_period_insert
BEFORE INSERT ON plan_histories
WHEN EXISTS (
    SELECT 1
    FROM plan_versions pv
    JOIN logical_accounts la ON la.logical_account_id = NEW.logical_account_id
    JOIN plans p ON p.plan_id = pv.plan_id
    WHERE pv.plan_version_id = NEW.plan_version_id
      AND (
          NEW.valid_from < pv.valid_from
          OR (pv.valid_to IS NOT NULL AND NEW.valid_to IS NULL)
          OR (pv.valid_to IS NOT NULL AND NEW.valid_to IS NOT NULL AND NEW.valid_to > pv.valid_to)
          OR p.service_id <> la.service_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'plan history is outside plan version period');
END;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TRIGGER plan_histories_plan_period_update
BEFORE UPDATE OF logical_account_id, plan_version_id, valid_from, valid_to ON plan_histories
WHEN EXISTS (
    SELECT 1
    FROM plan_versions pv
    JOIN logical_accounts la ON la.logical_account_id = NEW.logical_account_id
    JOIN plans p ON p.plan_id = pv.plan_id
    WHERE pv.plan_version_id = NEW.plan_version_id
      AND (
          NEW.valid_from < pv.valid_from
          OR (pv.valid_to IS NOT NULL AND NEW.valid_to IS NULL)
          OR (pv.valid_to IS NOT NULL AND NEW.valid_to IS NOT NULL AND NEW.valid_to > pv.valid_to)
          OR p.service_id <> la.service_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'plan history is outside plan version period');
END;
-- +goose StatementEnd

UPDATE schema_metadata SET schema_version = 8 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 7 WHERE singleton = 1;
DROP TRIGGER plan_histories_plan_period_update;
DROP TRIGGER plan_histories_plan_period_insert;
DROP TRIGGER plan_histories_no_overlap_update;
DROP TRIGGER plan_histories_no_overlap_insert;
DROP TRIGGER hub_account_candidates_service_match_update;
DROP TRIGGER hub_account_candidates_service_match_insert;
DROP INDEX plan_histories_account_period;
DROP TABLE plan_histories;
DROP INDEX hub_account_candidates_logical;
DROP INDEX hub_account_candidates_lookup;
DROP TABLE hub_account_candidates;
DROP INDEX logical_accounts_service_state;
DROP TABLE logical_accounts;
