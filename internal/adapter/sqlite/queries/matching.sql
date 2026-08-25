-- name: ListEstimationPointsByInterval :many
SELECT estimation_point_id, service_id, limit_definition_id, plan_version_id,
       cycle_type, calculation_interval_id, calculation_interval_ids_json,
       reference_at, shared_cost, utilization_json, limit_series_ids_json,
       limit_series_logical_account_ids_json, limit_series_plan_version_ids_json,
       limit_series_calculation_interval_ids_json, cost_source_ids_json,
       association_ids_json, completeness_ids_json, matching_rule_version,
       calculation_logic_version, created_at, updated_at
FROM estimation_points
WHERE calculation_interval_id = sqlc.arg(calculation_interval_id)
   OR EXISTS (SELECT 1 FROM json_each(estimation_points.calculation_interval_ids_json) WHERE json_each.value = sqlc.arg(calculation_interval_id))
ORDER BY reference_at, estimation_point_id;

-- name: ListMatchedObservationsByPoint :many
SELECT matched_observation_id, estimation_point_id, observation_role, source_id,
       logical_account_id, observation_id, observed_at, time_delta_ns,
       tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms,
       limits_refresh_ms, normalization_generation, normalization_rule_version,
       normalization_logic_version
FROM matched_observations
WHERE estimation_point_id = sqlc.arg(estimation_point_id)
ORDER BY observation_role, source_id, observation_id, matched_observation_id;
