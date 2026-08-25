package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

// ListCurrentLimitSeries returns every currently effective account limit
// association. A missing interval or result is intentionally represented in
// the row so M03 can explain why a series is not computed.
func (l *Lifecycle) ListCurrentLimitSeries(ctx context.Context, now time.Time) ([]domain.LimitSeriesView, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	instant := utcText(now)
	rows, err := database.QueryContext(ctx, `
SELECT
  ula.usage_limit_association_id, s.service_id, s.name,
  la.logical_account_id, la.display_name,
  ld.limit_definition_id, ld.meaning, ld.cycle_type,
  uls.usage_limit_source_id, uls.normalized_kind, uls.normalized_metric,
  ph.plan_history_id, pv.plan_version_id, pv.name,
  plr.plan_limit_rule_id, plr.plan_limit, plr.limit_multiplier,
  lo.used_percent, lo.resets_at, lo.provider_updated_at,
  CASE WHEN EXISTS (
    SELECT 1 FROM usage_limit_observations conflict
    JOIN usage_limit_sources conflictSource
      ON conflictSource.hub_id = conflict.hub_id
     AND conflictSource.device_id = conflict.device_id
     AND conflictSource.raw_service_identifier = conflict.raw_service_identifier
     AND conflictSource.account_key = conflict.account_key
     AND conflictSource.window_key = conflict.window_key
     AND conflictSource.normalized_kind = conflict.normalized_kind
     AND conflictSource.normalized_metric = conflict.normalized_metric
     AND conflictSource.normalized_label = conflict.normalized_label
    WHERE conflictSource.usage_limit_source_id = uls.usage_limit_source_id
      AND conflict.dedupe_state = 'conflict'
      AND conflict.provider_updated_at >= ula.valid_from
      AND (ula.valid_to IS NULL OR conflict.provider_updated_at < ula.valid_to)
  ) THEN 1 ELSE 0 END,
  ci.calculation_interval_id, ci.service_id, ci.logical_account_id,
  ci.usage_limit_source_id, ci.limit_definition_id, ci.plan_version_id,
  ci.cycle_type, ci.valid_from, ci.valid_to, ci.state, ci.exclusion_reason,
  ci.boundary_ids_json
FROM usage_limit_source_links ula
JOIN usage_limit_sources uls ON uls.usage_limit_source_id = ula.usage_limit_source_id
JOIN logical_accounts la ON la.logical_account_id = ula.logical_account_id
JOIN limit_definitions ld ON ld.limit_definition_id = ula.limit_definition_id
JOIN services s ON s.service_id = ld.service_id
LEFT JOIN plan_histories ph
  ON ph.logical_account_id = la.logical_account_id
 AND ph.valid_from <= ? AND (ph.valid_to IS NULL OR ? < ph.valid_to)
LEFT JOIN plan_versions pv ON pv.plan_version_id = ph.plan_version_id
LEFT JOIN plan_limit_rules plr
  ON plr.plan_version_id = pv.plan_version_id
 AND plr.limit_definition_id = ld.limit_definition_id
LEFT JOIN usage_limit_observations lo ON lo.observation_id = (
  SELECT newest.observation_id
  FROM usage_limit_observations newest
  JOIN usage_limit_sources newestSource
    ON newestSource.hub_id = newest.hub_id
   AND newestSource.device_id = newest.device_id
   AND newestSource.raw_service_identifier = newest.raw_service_identifier
   AND newestSource.account_key = newest.account_key
   AND newestSource.window_key = newest.window_key
   AND newestSource.normalized_kind = uls.normalized_kind
   AND newestSource.normalized_metric = uls.normalized_metric
   AND newestSource.normalized_label = uls.normalized_label
  WHERE newestSource.usage_limit_source_id = uls.usage_limit_source_id
    AND newest.dedupe_state = 'canonical'
    AND (newest.used_percent IS NULL OR (newest.used_percent = newest.used_percent AND newest.used_percent >= 0 AND newest.used_percent <= 100))
    AND newest.provider_updated_at >= ula.valid_from
    AND (ula.valid_to IS NULL OR newest.provider_updated_at < ula.valid_to)
  ORDER BY newest.provider_updated_at DESC, newest.observation_id DESC
  LIMIT 1
)
LEFT JOIN calculation_intervals ci
  ON ci.usage_limit_source_id = uls.usage_limit_source_id
 AND ci.logical_account_id = la.logical_account_id
 AND ci.limit_definition_id = ld.limit_definition_id
 AND ci.service_id = s.service_id
 AND ci.valid_from <= ? AND ? < ci.valid_to
WHERE ula.valid_from <= ? AND (ula.valid_to IS NULL OR ? < ula.valid_to)
  AND la.archived_at IS NULL AND ld.archived_at IS NULL AND s.archived_at IS NULL
  AND la.service_id = ld.service_id
ORDER BY s.name, la.display_name, ld.meaning, ula.usage_limit_association_id`,
		instant, instant, instant, instant, instant, instant)
	if err != nil {
		return nil, fmt.Errorf("list current limit series: %w", err)
	}
	result := make([]domain.LimitSeriesView, 0)
	for rows.Next() {
		var item domain.LimitSeriesView
		var planHistoryID, planVersionID, planVersionName, ruleID sql.NullString
		var planLimit, multiplier, used sql.NullFloat64
		var resetsAt, observationAt sql.NullString
		var conflict int
		var intervalID, intervalService, intervalAccount, intervalSource, intervalDefinition, intervalPlan, intervalCycle sql.NullString
		var intervalFrom, intervalTo, intervalState, intervalReason, boundaryJSON sql.NullString
		if err := rows.Scan(
			&item.AssociationID, &item.ServiceID, &item.ServiceName,
			&item.LogicalAccountID, &item.LogicalAccountName,
			&item.LimitDefinitionID, &item.LimitDefinitionName, &item.CycleType,
			&item.UsageLimitSourceID, &item.NormalizedKind, &item.NormalizedMetric,
			&planHistoryID, &planVersionID, &planVersionName,
			&ruleID, &planLimit, &multiplier,
			&used, &resetsAt, &observationAt, &conflict,
			&intervalID, &intervalService, &intervalAccount, &intervalSource, &intervalDefinition,
			&intervalPlan, &intervalCycle, &intervalFrom, &intervalTo, &intervalState, &intervalReason, &boundaryJSON,
		); err != nil {
			return nil, fmt.Errorf("scan current limit series: %w", err)
		}
		item.ID = item.AssociationID
		item.PlanHistoryID = planHistoryID.String
		item.PlanVersionID = planVersionID.String
		item.PlanVersionName = planVersionName.String
		item.PlanLimitRuleID = ruleID.String
		if planLimit.Valid {
			value := planLimit.Float64
			item.PlanLimit = &value
		}
		if multiplier.Valid {
			value := multiplier.Float64
			item.Multiplier = &value
		}
		if used.Valid {
			value := used.Float64
			item.UsedPercent = &value
			remaining := 100 - value
			item.RemainingPercent = &remaining
		}
		if resetsAt.Valid {
			parsed, parseErr := parseUTC(resetsAt.String)
			if parseErr != nil {
				return nil, parseErr
			}
			item.ResetAt = &parsed
		}
		if observationAt.Valid {
			parsed, parseErr := parseUTC(observationAt.String)
			if parseErr != nil {
				return nil, parseErr
			}
			item.LatestObservationAt = &parsed
		}
		if intervalID.Valid {
			from, parseErr := parseUTC(intervalFrom.String)
			if parseErr != nil {
				return nil, parseErr
			}
			to, parseErr := parseUTC(intervalTo.String)
			if parseErr != nil {
				return nil, parseErr
			}
			var boundaryIDs []string
			if boundaryJSON.Valid && boundaryJSON.String != "" {
				if err := json.Unmarshal([]byte(boundaryJSON.String), &boundaryIDs); err != nil {
					return nil, fmt.Errorf("decode calculation boundaries: %w", err)
				}
			}
			item.Interval = &domain.CalculationIntervalView{
				ID: intervalID.String, ServiceID: intervalService.String,
				LogicalAccountID: intervalAccount.String, UsageLimitSourceID: intervalSource.String,
				LimitDefinitionID: intervalDefinition.String, PlanVersionID: intervalPlan.String,
				CycleType: intervalCycle.String, ValidFrom: from, ValidTo: to,
				State: intervalState.String, ExclusionReason: intervalReason.String, BoundaryIDs: boundaryIDs,
			}
		}
		item.HasConflict = conflict != 0
		if item.HasConflict {
			item.SeriesState = "inconsistent"
		} else {
			item.SeriesState = "normal"
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("read current limit series: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		if result[index].Interval == nil {
			continue
		}
		boundaries, err := loadCalculationBoundaries(ctx, database, result[index].Interval.BoundaryIDs)
		if err != nil {
			return nil, err
		}
		result[index].Interval.Boundaries = boundaries
		if result[index].HasConflict {
			result[index].SeriesState = "inconsistent"
		} else if result[index].LatestObservationAt == nil {
			for _, boundary := range boundaries {
				if boundary.Kind == "hub_switch" || boundary.Kind == "api_contract" || boundary.Kind == "unexplained_decrease" {
					result[index].SeriesState = "disconnected"
					break
				}
			}
		}
	}
	return result, nil
}

// ListCalculationIntervalViews is used by the M03 history pane. The query
// returns intervals for one account/definition/source tuple, including
// excluded intervals and their boundaries.
func (l *Lifecycle) ListCalculationIntervalViews(ctx context.Context, serviceID, accountID, definitionID, sourceID string) ([]domain.CalculationIntervalView, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json FROM calculation_intervals WHERE service_id = ? AND logical_account_id = ? AND limit_definition_id = ? AND usage_limit_source_id = ? ORDER BY valid_from, calculation_interval_id`, serviceID, accountID, definitionID, sourceID)
	if err != nil {
		return nil, fmt.Errorf("list calculation interval history: %w", err)
	}
	result := make([]domain.CalculationIntervalView, 0)
	for rows.Next() {
		var item domain.CalculationIntervalView
		var planVersion, from, to, boundaryJSON string
		if err := rows.Scan(&item.ID, &item.ServiceID, &item.LogicalAccountID, &item.UsageLimitSourceID, &item.LimitDefinitionID, &planVersion, &item.CycleType, &from, &to, &item.State, &item.ExclusionReason, &boundaryJSON); err != nil {
			return nil, err
		}
		item.PlanVersionID = planVersion
		item.ValidFrom, err = parseUTC(from)
		if err != nil {
			return nil, err
		}
		item.ValidTo, err = parseUTC(to)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(boundaryJSON), &item.BoundaryIDs); err != nil {
			return nil, fmt.Errorf("decode calculation interval boundaries: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		boundaries, err := loadCalculationBoundaries(ctx, database, result[index].BoundaryIDs)
		if err != nil {
			return nil, err
		}
		result[index].Boundaries = boundaries
	}
	return result, nil
}

func loadCalculationBoundaries(ctx context.Context, database *sql.DB, ids []string) ([]domain.CalculationBoundaryView, error) {
	result := make([]domain.CalculationBoundaryView, 0, len(ids))
	for _, id := range ids {
		var item domain.CalculationBoundaryView
		var at string
		if err := database.QueryRowContext(ctx, `SELECT calculation_boundary_id, boundary_kind, boundary_at, reason, related_id FROM calculation_boundaries WHERE calculation_boundary_id = ?`, id).Scan(&item.ID, &item.Kind, &at, &item.Reason, &item.RelatedID); err != nil {
			if err == sql.ErrNoRows {
				continue
			}
			return nil, err
		}
		var err error
		item.At, err = parseUTC(at)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
}
