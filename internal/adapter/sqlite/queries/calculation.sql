-- name: ListCalculationIntervalsBySource :many
SELECT calculation_interval_id, service_id, logical_account_id, usage_limit_source_id,
       limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to,
       state, exclusion_reason, boundary_ids_json, created_at, updated_at
FROM calculation_intervals
WHERE usage_limit_source_id = sqlc.arg(usage_limit_source_id)
ORDER BY valid_from, calculation_interval_id;

-- name: ListCalculationBoundariesBySource :many
SELECT calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id,
       boundary_at, boundary_kind, reason, related_id, created_at
FROM calculation_boundaries
WHERE usage_limit_source_id = sqlc.arg(usage_limit_source_id)
ORDER BY boundary_at, calculation_boundary_id;
