-- name: ListUsageCostSourcesByHub :many
SELECT usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at
FROM usage_cost_sources
WHERE hub_id = sqlc.arg(hub_id)
ORDER BY hub_id, device_id, raw_service_identifier, usage_cost_source_id;

-- name: ListUsageLimitSourcesByHub :many
SELECT usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier,
       window_key, normalized_kind, normalized_metric, normalized_label, created_at
FROM usage_limit_sources
WHERE hub_id = sqlc.arg(hub_id)
ORDER BY hub_id, device_id, raw_service_identifier, account_key, window_key, usage_limit_source_id;

-- name: ListUsageCostAssociationsBySource :many
SELECT usage_cost_association_id, usage_cost_source_id, logical_account_id,
       valid_from, valid_to, created_at, updated_at
FROM usage_cost_source_account_links
WHERE usage_cost_source_id = sqlc.arg(usage_cost_source_id)
ORDER BY valid_from, usage_cost_association_id;

-- name: ListUsageLimitAssociationsBySource :many
SELECT usage_limit_association_id, usage_limit_source_id, logical_account_id,
       limit_definition_id, valid_from, valid_to, created_at, updated_at
FROM usage_limit_source_links
WHERE usage_limit_source_id = sqlc.arg(usage_limit_source_id)
ORDER BY valid_from, usage_limit_association_id;

-- name: ListUsageCostSourceCompletenessBySource :many
SELECT completeness_id, usage_cost_source_id, valid_from, valid_to, state,
       logical_account_ids_json, excluded_activity_json, created_at, updated_at
FROM usage_cost_source_completeness
WHERE usage_cost_source_id = sqlc.arg(usage_cost_source_id)
ORDER BY valid_from, completeness_id;
