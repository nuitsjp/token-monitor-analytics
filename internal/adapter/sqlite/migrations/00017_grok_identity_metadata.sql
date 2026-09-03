-- +goose Up
ALTER TABLE usage_limit_observations ADD COLUMN account_key_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_limit_observations ADD COLUMN account_display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_limit_observations ADD COLUMN account_email TEXT NOT NULL DEFAULT '';
ALTER TABLE hub_account_candidates ADD COLUMN account_key_kind TEXT NOT NULL DEFAULT '';

-- Existing Grok observations used the legacy credential fingerprint. Keep that
-- fact as evidence, but let reconciliation distinguish it from stable OIDC
-- subject observations.
UPDATE usage_limit_observations
SET account_key_kind = 'legacy-credential-fingerprint'
WHERE raw_service_identifier = 'grok';

UPDATE hub_account_candidates
SET account_key_kind = 'legacy-credential-fingerprint'
WHERE service_id IN (SELECT service_id FROM services WHERE official_key = 'grok');

UPDATE schema_metadata SET schema_version = 17 WHERE singleton = 1;

-- +goose Down
UPDATE schema_metadata SET schema_version = 16 WHERE singleton = 1;
ALTER TABLE hub_account_candidates DROP COLUMN account_key_kind;
ALTER TABLE usage_limit_observations DROP COLUMN account_email;
ALTER TABLE usage_limit_observations DROP COLUMN account_display_name;
ALTER TABLE usage_limit_observations DROP COLUMN account_key_kind;
