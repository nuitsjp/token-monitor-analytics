package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

// PreviewPurge reports logical raw JSON capacity for selected snapshots.
// SQLite file compaction is intentionally not inferred from this logical byte
// count.
func (l *Lifecycle) Capacity(ctx context.Context) (domain.DataCapacity, error) {
	preview, err := l.PreviewPurge(ctx, domain.PurgeSelection{AllHubs: true})
	if err != nil {
		return domain.DataCapacity{}, err
	}
	return preview.Capacity, nil
}

func (l *Lifecycle) PreviewPurge(ctx context.Context, selection domain.PurgeSelection) (domain.PurgePreview, error) {
	selection, err := selection.Normalized()
	if err != nil {
		return domain.PurgePreview{}, err
	}
	database, err := l.DB()
	if err != nil {
		return domain.PurgePreview{}, err
	}
	where, args := purgeSnapshotWhere(selection)
	var count, bytes sql.NullInt64
	var oldest, latest sql.NullString
	if err := database.QueryRowContext(ctx, `
		SELECT COUNT(*), MIN(rs.received_completed_at), MAX(rs.received_completed_at), COALESCE(SUM(length(rs.body)), 0)
		FROM raw_snapshots rs
		WHERE `+where, args...).Scan(&count, &oldest, &latest, &bytes); err != nil {
		return domain.PurgePreview{}, fmt.Errorf("preview purge: %w", err)
	}
	capacity := domain.DataCapacity{RawSnapshotCount: count.Int64, RawJSONBytes: bytes.Int64}
	if oldest.Valid {
		value, parseErr := parseUTC(oldest.String)
		if parseErr != nil {
			return domain.PurgePreview{}, fmt.Errorf("parse purge oldest completion: %w", parseErr)
		}
		capacity.OldestCompletedAt = &value
	}
	if latest.Valid {
		value, parseErr := parseUTC(latest.String)
		if parseErr != nil {
			return domain.PurgePreview{}, fmt.Errorf("parse purge latest completion: %w", parseErr)
		}
		capacity.LatestCompletedAt = &value
	}
	path, err := l.DatabasePath()
	if err != nil {
		return domain.PurgePreview{}, err
	}
	if info, statErr := os.Stat(path); statErr == nil {
		capacity.DatabaseSizeBytes = info.Size()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return domain.PurgePreview{}, fmt.Errorf("stat database: %w", statErr)
	}
	return domain.PurgePreview{Selection: selection, Capacity: capacity}, nil
}

// Purge performs raw deletion, dependent deletion, remaining-result
// recalculation, and the success audit in one SQLite transaction.
func (l *Lifecycle) Purge(ctx context.Context, selection domain.PurgeSelection, executedAt time.Time) (domain.PurgeResult, error) {
	return l.purgeWithInjector(ctx, selection, executedAt, nil)
}

func (l *Lifecycle) purgeWithInjector(ctx context.Context, selection domain.PurgeSelection, executedAt time.Time, injector FailureInjector) (domain.PurgeResult, error) {
	selection, err := selection.Normalized()
	if err != nil {
		return domain.PurgeResult{}, err
	}
	if executedAt.IsZero() {
		return domain.PurgeResult{}, errors.New("purge execution time is required")
	}
	database, err := l.DB()
	if err != nil {
		return domain.PurgeResult{}, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("begin purge: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	snapshotIDs, err := querySelectedSnapshotIDs(ctx, tx, selection)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	if len(snapshotIDs) == 0 {
		return domain.PurgeResult{}, domain.ErrPurgeNoTargets
	}
	if err := inject(injector, "after-selection"); err != nil {
		return domain.PurgeResult{}, err
	}
	costIDs, err := queryIDs(ctx, tx, `SELECT observation_id FROM usage_cost_observations WHERE snapshot_id IN (`+placeholders(len(snapshotIDs))+`) ORDER BY observation_id`, stringsToAny(snapshotIDs)...)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("find purge cost observations: %w", err)
	}
	limitIDs, err := queryIDs(ctx, tx, `SELECT observation_id FROM usage_limit_observations WHERE snapshot_id IN (`+placeholders(len(snapshotIDs))+`) ORDER BY observation_id`, stringsToAny(snapshotIDs)...)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("find purge limit observations: %w", err)
	}
	pointIDs, err := queryMatchedPointIDs(ctx, tx, costIDs, limitIDs)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	matchedCount, err := queryCount(ctx, tx, `SELECT COUNT(*) FROM matched_observations WHERE estimation_point_id IN (`+placeholders(len(pointIDs))+`)`, stringsToAny(pointIDs)...)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("count purge matched observations: %w", err)
	}
	resultIDs, err := queryResultIDs(ctx, tx, pointIDs)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	evidenceCount, err := queryCount(ctx, tx, `SELECT COUNT(*) FROM estimation_result_evidence WHERE estimation_result_id IN (`+placeholders(len(resultIDs))+`)`, stringsToAny(resultIDs)...)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("count purge evidence: %w", err)
	}
	intervalIDs, boundaryIDs, err := queryPointIntervals(ctx, tx, pointIDs)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	result := domain.PurgeResult{
		ExecutedAt:               executedAt.UTC(),
		RawSnapshotCount:         int64(len(snapshotIDs)),
		CostObservationCount:     int64(len(costIDs)),
		LimitObservationCount:    int64(len(limitIDs)),
		MatchedObservationCount:  matchedCount,
		EstimationPointCount:     int64(len(pointIDs)),
		EstimationResultCount:    int64(len(resultIDs)),
		EstimationEvidenceCount:  evidenceCount,
		CalculationIntervalCount: 0,
		CalculationBoundaryCount: int64(len(boundaryIDs)),
	}
	if err := inject(injector, "after-dependency-selection"); err != nil {
		return domain.PurgeResult{}, err
	}

	if len(resultIDs) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM estimation_results WHERE estimation_result_id IN (`+placeholders(len(resultIDs))+`)`, stringsToAny(resultIDs)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge estimation results: %w", err)
		}
	}
	if err := inject(injector, "after-results"); err != nil {
		return domain.PurgeResult{}, err
	}
	if len(pointIDs) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM matched_observations WHERE estimation_point_id IN (`+placeholders(len(pointIDs))+`)`, stringsToAny(pointIDs)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge matched observations: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM estimation_points WHERE estimation_point_id IN (`+placeholders(len(pointIDs))+`)`, stringsToAny(pointIDs)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge estimation points: %w", err)
		}
	}
	if err := inject(injector, "after-points"); err != nil {
		return domain.PurgeResult{}, err
	}

	remainingIntervals := make([]string, 0, len(intervalIDs))
	deleteIntervals := make([]string, 0, len(intervalIDs))
	for _, intervalID := range intervalIDs {
		var count int64
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM estimation_points WHERE calculation_interval_id = ? OR EXISTS (SELECT 1 FROM json_each(estimation_points.calculation_interval_ids_json) WHERE json_each.value = ?)`, intervalID, intervalID).Scan(&count); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("count remaining estimation points: %w", err)
		}
		if count == 0 {
			deleteIntervals = append(deleteIntervals, intervalID)
		} else {
			remainingIntervals = append(remainingIntervals, intervalID)
		}
	}
	if len(deleteIntervals) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM calculation_intervals WHERE calculation_interval_id IN (`+placeholders(len(deleteIntervals))+`)`, stringsToAny(deleteIntervals)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge calculation intervals: %w", err)
		}
	}
	result.CalculationIntervalCount = int64(len(deleteIntervals))
	if err := inject(injector, "after-intervals"); err != nil {
		return domain.PurgeResult{}, err
	}
	deleteBoundaries, err := boundariesNoLongerReferenced(ctx, tx, boundaryIDs)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	if len(deleteBoundaries) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM calculation_boundaries WHERE calculation_boundary_id IN (`+placeholders(len(deleteBoundaries))+`)`, stringsToAny(deleteBoundaries)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge calculation boundaries: %w", err)
		}
	}
	result.CalculationBoundaryCount = int64(len(deleteBoundaries))

	if len(costIDs) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM usage_cost_observations WHERE observation_id IN (`+placeholders(len(costIDs))+`)`, stringsToAny(costIDs)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge cost observations: %w", err)
		}
	}
	if len(limitIDs) > 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM usage_limit_observations WHERE observation_id IN (`+placeholders(len(limitIDs))+`)`, stringsToAny(limitIDs)...); err != nil {
			return domain.PurgeResult{}, fmt.Errorf("delete purge limit observations: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM raw_snapshots WHERE snapshot_id IN (`+placeholders(len(snapshotIDs))+`)`, stringsToAny(snapshotIDs)...); err != nil {
		return domain.PurgeResult{}, fmt.Errorf("delete purge raw snapshots: %w", err)
	}
	if err := inject(injector, "after-observations"); err != nil {
		return domain.PurgeResult{}, err
	}

	for _, intervalID := range remainingIntervals {
		if err := purgeRecalculateIntervalTx(ctx, tx, intervalID, executedAt.UTC()); err != nil {
			return domain.PurgeResult{}, err
		}
		result.RecalculatedResultCount++
	}
	if err := inject(injector, "after-recalculation"); err != nil {
		return domain.PurgeResult{}, err
	}

	auditID := uuid.NewString()
	result.AuditID = auditID
	beforeJSON, err := json.Marshal(domain.PurgePreview{Selection: selection, Capacity: domain.DataCapacity{RawSnapshotCount: int64(len(snapshotIDs))}})
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("encode purge audit before: %w", err)
	}
	afterJSON, err := json.Marshal(result)
	if err != nil {
		return domain.PurgeResult{}, fmt.Errorf("encode purge audit after: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, auditID, utcText(executedAt.UTC()), "system", "data_purge", "data_purge", auditID, string(beforeJSON), string(afterJSON)); err != nil {
		return domain.PurgeResult{}, fmt.Errorf("insert purge audit: %w", err)
	}
	if err := inject(injector, "before-commit"); err != nil {
		return domain.PurgeResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.PurgeResult{}, fmt.Errorf("commit purge: %w", err)
	}
	return result, nil
}

func purgeSnapshotWhere(selection domain.PurgeSelection) (string, []any) {
	conditions := []string{"rs.received_completed_at IS NOT NULL"}
	args := make([]any, 0, len(selection.HubIDs)+2)
	if !selection.AllHubs {
		conditions = append(conditions, "rs.hub_id IN ("+placeholders(len(selection.HubIDs))+")")
		args = append(args, stringsToAny(selection.HubIDs)...)
	}
	if selection.Start != nil {
		conditions = append(conditions, "rs.received_completed_at >= ?")
		args = append(args, utcText(*selection.Start))
	}
	if selection.End != nil {
		conditions = append(conditions, "rs.received_completed_at < ?")
		args = append(args, utcText(*selection.End))
	}
	return strings.Join(conditions, " AND "), args
}

func querySelectedSnapshotIDs(ctx context.Context, tx *sql.Tx, selection domain.PurgeSelection) ([]string, error) {
	where, args := purgeSnapshotWhere(selection)
	return queryIDs(ctx, tx, `SELECT rs.snapshot_id FROM raw_snapshots rs WHERE `+where+` ORDER BY rs.snapshot_id`, args...)
}

func queryIDs(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func queryCount(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	var count int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func queryMatchedPointIDs(ctx context.Context, tx *sql.Tx, costIDs, limitIDs []string) ([]string, error) {
	conditions := make([]string, 0, 2)
	args := make([]any, 0, len(costIDs)+len(limitIDs))
	if len(costIDs) > 0 {
		conditions = append(conditions, "(observation_role = 'cost' AND observation_id IN ("+placeholders(len(costIDs))+"))")
		args = append(args, stringsToAny(costIDs)...)
	}
	if len(limitIDs) > 0 {
		conditions = append(conditions, "(observation_role = 'limit' AND observation_id IN ("+placeholders(len(limitIDs))+"))")
		args = append(args, stringsToAny(limitIDs)...)
	}
	if len(conditions) == 0 {
		return nil, nil
	}
	return queryIDs(ctx, tx, `SELECT DISTINCT estimation_point_id FROM matched_observations WHERE `+strings.Join(conditions, " OR ")+` ORDER BY estimation_point_id`, args...)
}

func queryResultIDs(ctx context.Context, tx *sql.Tx, pointIDs []string) ([]string, error) {
	if len(pointIDs) == 0 {
		return nil, nil
	}
	return queryIDs(ctx, tx, `SELECT DISTINCT estimation_result_id FROM estimation_result_evidence WHERE point_id IN (`+placeholders(len(pointIDs))+`) ORDER BY estimation_result_id`, stringsToAny(pointIDs)...)
}

func queryPointIntervals(ctx context.Context, tx *sql.Tx, pointIDs []string) ([]string, []string, error) {
	if len(pointIDs) == 0 {
		return nil, nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT calculation_interval_id, calculation_interval_ids_json, limit_series_calculation_interval_ids_json FROM estimation_points WHERE estimation_point_id IN (`+placeholders(len(pointIDs))+`)`, stringsToAny(pointIDs)...)
	if err != nil {
		return nil, nil, err
	}
	intervalSet := make(map[string]struct{})
	boundarySet := make(map[string]struct{})
	for rows.Next() {
		var scalar, intervalsJSON, seriesJSON string
		if err := rows.Scan(&scalar, &intervalsJSON, &seriesJSON); err != nil {
			return nil, nil, err
		}
		intervalSet[scalar] = struct{}{}
		for _, encoded := range []string{intervalsJSON, seriesJSON} {
			var ids []string
			if err := json.Unmarshal([]byte(encoded), &ids); err != nil {
				return nil, nil, fmt.Errorf("decode purge point intervals: %w", err)
			}
			for _, id := range ids {
				if strings.TrimSpace(id) != "" {
					intervalSet[id] = struct{}{}
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	intervalIDs := sortedKeys(intervalSet)
	if len(intervalIDs) == 0 {
		return nil, nil, nil
	}
	rows, err = tx.QueryContext(ctx, `SELECT boundary_ids_json FROM calculation_intervals WHERE calculation_interval_id IN (`+placeholders(len(intervalIDs))+`)`, stringsToAny(intervalIDs)...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, nil, err
		}
		var ids []string
		if err := json.Unmarshal([]byte(encoded), &ids); err != nil {
			return nil, nil, fmt.Errorf("decode purge boundaries: %w", err)
		}
		for _, id := range ids {
			if strings.TrimSpace(id) != "" {
				boundarySet[id] = struct{}{}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return intervalIDs, sortedKeys(boundarySet), nil
}

func boundariesNoLongerReferenced(ctx context.Context, tx *sql.Tx, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		var count int64
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM calculation_intervals WHERE EXISTS (SELECT 1 FROM json_each(calculation_intervals.boundary_ids_json) WHERE json_each.value = ?)`, id).Scan(&count); err != nil {
			return nil, fmt.Errorf("check purge boundary references: %w", err)
		}
		if count == 0 {
			result = append(result, id)
		}
	}
	return result, nil
}

func placeholders(count int) string {
	if count <= 0 {
		return "NULL"
	}
	values := make([]string, count)
	for index := range values {
		values[index] = "?"
	}
	return strings.Join(values, ",")
}

func stringsToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

func sortedKeys(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func purgeRecalculateIntervalTx(ctx context.Context, tx *sql.Tx, intervalID string, now time.Time) error {
	points, err := listEstimationPointsTx(ctx, tx, intervalID)
	if err != nil {
		return err
	}
	if len(points) == 0 {
		return nil
	}
	input, err := listEstimationInputTx(ctx, tx, intervalID, points)
	if err != nil {
		return err
	}
	estimate, err := domain.EstimateFromPoints(input)
	if err != nil {
		return fmt.Errorf("recalculate purge interval: %w", err)
	}
	interval, err := findPurgeCalculationInterval(input.Intervals, intervalID)
	if err != nil {
		return err
	}
	result := domain.DerivedResult{
		ID:                     uuid.NewString(),
		ServiceID:              interval.ServiceID,
		LimitDefinitionID:      interval.LimitDefinitionID,
		CycleType:              interval.CycleType,
		CalculationIntervalIDs: []string{interval.ID},
		ValidFrom:              interval.ValidFrom,
		ValidTo:                interval.ValidTo,
		EstimationResult:       estimate,
		Points:                 points,
		Intervals:              input.Intervals,
		CreatedAt:              now,
		UpdatedAt:              now,
	}
	return saveDerivedResultTx(ctx, tx, result)
}

func listEstimationPointsTx(ctx context.Context, tx *sql.Tx, intervalID string) ([]domain.EstimationPoint, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT estimation_point_id, service_id, limit_definition_id, plan_version_id, cycle_type,
		       calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost,
		       utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json,
		       limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json,
		       cost_source_ids_json, association_ids_json, completeness_ids_json,
		       matching_rule_version, calculation_logic_version, created_at, updated_at
		FROM estimation_points
		WHERE calculation_interval_id = ?
		   OR EXISTS (SELECT 1 FROM json_each(estimation_points.calculation_interval_ids_json) WHERE json_each.value = ?)
		ORDER BY reference_at, estimation_point_id`, intervalID, intervalID)
	if err != nil {
		return nil, fmt.Errorf("list purge estimation points: %w", err)
	}
	type pointRow struct {
		point                                                              domain.EstimationPoint
		planID                                                             sql.NullString
		intervalsJSON, utilizationJSON, seriesJSON, accountJSON, planJSON  string
		seriesIntervalsJSON, costsJSON, associationsJSON, completenessJSON string
		reference, created, updated                                        string
	}
	pointRows := make([]pointRow, 0)
	for rows.Next() {
		var item pointRow
		if err := rows.Scan(&item.point.ID, &item.point.ServiceID, &item.point.LimitDefinitionID, &item.planID, &item.point.CycleType, &item.point.CalculationIntervalID, &item.intervalsJSON, &item.reference, &item.point.SharedCost, &item.utilizationJSON, &item.seriesJSON, &item.accountJSON, &item.planJSON, &item.seriesIntervalsJSON, &item.costsJSON, &item.associationsJSON, &item.completenessJSON, &item.point.MatchingRuleVersion, &item.point.CalculationLogicVersion, &item.created, &item.updated); err != nil {
			return nil, fmt.Errorf("scan purge estimation point: %w", err)
		}
		pointRows = append(pointRows, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	result := make([]domain.EstimationPoint, 0, len(pointRows))
	for _, item := range pointRows {
		point := item.point
		point.PlanVersionID = item.planID.String
		if err := json.Unmarshal([]byte(item.intervalsJSON), &point.CalculationIntervalIDs); err != nil {
			return nil, fmt.Errorf("decode purge point intervals: %w", err)
		}
		if err := json.Unmarshal([]byte(item.utilizationJSON), &point.Utilization); err != nil {
			return nil, fmt.Errorf("decode purge point utilization: %w", err)
		}
		if err := json.Unmarshal([]byte(item.seriesJSON), &point.LimitSeriesIDs); err != nil {
			return nil, fmt.Errorf("decode purge point series: %w", err)
		}
		if err := json.Unmarshal([]byte(item.accountJSON), &point.LimitSeriesLogicalAccountIDs); err != nil {
			return nil, fmt.Errorf("decode purge point accounts: %w", err)
		}
		if err := json.Unmarshal([]byte(item.planJSON), &point.LimitSeriesPlanVersionIDs); err != nil {
			return nil, fmt.Errorf("decode purge point plans: %w", err)
		}
		if err := json.Unmarshal([]byte(item.seriesIntervalsJSON), &point.LimitSeriesCalculationIntervalIDs); err != nil {
			return nil, fmt.Errorf("decode purge point series intervals: %w", err)
		}
		if err := json.Unmarshal([]byte(item.costsJSON), &point.CostSourceIDs); err != nil {
			return nil, fmt.Errorf("decode purge point costs: %w", err)
		}
		if err := json.Unmarshal([]byte(item.associationsJSON), &point.AssociationIDs); err != nil {
			return nil, fmt.Errorf("decode purge point associations: %w", err)
		}
		if err := json.Unmarshal([]byte(item.completenessJSON), &point.CompletenessIDs); err != nil {
			return nil, fmt.Errorf("decode purge point completeness: %w", err)
		}
		point.ReferenceAt, err = parseUTC(item.reference)
		if err != nil {
			return nil, err
		}
		point.CreatedAt, err = parseUTC(item.created)
		if err != nil {
			return nil, err
		}
		point.UpdatedAt, err = parseUTC(item.updated)
		if err != nil {
			return nil, err
		}
		point.MatchedObservations, err = listMatchedObservationsTx(ctx, tx, point.ID)
		if err != nil {
			return nil, err
		}
		if err := point.Validate(); err != nil {
			return nil, fmt.Errorf("validate purge estimation point: %w", err)
		}
		result = append(result, point)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func listMatchedObservationsTx(ctx context.Context, tx *sql.Tx, pointID string) ([]domain.MatchedObservation, error) {
	rows, err := tx.QueryContext(ctx, `SELECT matched_observation_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version FROM matched_observations WHERE estimation_point_id = ? ORDER BY observation_role, source_id, observation_id, matched_observation_id`, pointID)
	if err != nil {
		return nil, fmt.Errorf("list purge matched observations: %w", err)
	}
	defer rows.Close()
	result := make([]domain.MatchedObservation, 0)
	for rows.Next() {
		var item domain.MatchedObservation
		var account sql.NullString
		var observed string
		var delta, tolerance int64
		var syncMS, refreshMS sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Role, &item.SourceID, &account, &item.ObservationID, &observed, &delta, &tolerance, &item.AnalyticsIntervalSeconds, &syncMS, &refreshMS, &item.NormalizationGeneration, &item.NormalizationRuleVersion, &item.NormalizationLogicVersion); err != nil {
			return nil, err
		}
		item.LogicalAccountID = account.String
		item.ObservedAt, err = parseUTC(observed)
		if err != nil {
			return nil, err
		}
		item.TimeDelta = time.Duration(delta)
		item.Tolerance = time.Duration(tolerance)
		if syncMS.Valid {
			value := syncMS.Int64
			item.SyncUploadIntervalMS = &value
		}
		if refreshMS.Valid {
			value := refreshMS.Int64
			item.LimitsRefreshMS = &value
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func listEstimationInputTx(ctx context.Context, tx *sql.Tx, intervalID string, points []domain.EstimationPoint) (domain.EstimationInput, error) {
	intervalSet := map[string]struct{}{intervalID: {}}
	planSet := make(map[string]struct{})
	for _, point := range points {
		for _, id := range point.CalculationIntervalIDs {
			intervalSet[id] = struct{}{}
		}
		for _, id := range point.LimitSeriesCalculationIntervalIDs {
			intervalSet[id] = struct{}{}
		}
		for _, id := range point.LimitSeriesPlanVersionIDs {
			planSet[id] = struct{}{}
		}
	}
	intervalIDs := sortedKeys(intervalSet)
	intervals, err := listCalculationIntervalsTx(ctx, tx, intervalIDs)
	if err != nil {
		return domain.EstimationInput{}, err
	}
	plans, err := loadEstimationPlansTx(ctx, tx, sortedKeys(planSet))
	if err != nil {
		return domain.EstimationInput{}, err
	}
	return domain.EstimationInput{Points: points, Intervals: intervals, PlanVersions: plans}, nil
}

func listCalculationIntervalsTx(ctx context.Context, tx *sql.Tx, ids []string) ([]domain.CalculationInterval, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at FROM calculation_intervals WHERE calculation_interval_id IN (`+placeholders(len(ids))+`) ORDER BY calculation_interval_id`, stringsToAny(ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.CalculationInterval, 0, len(ids))
	for rows.Next() {
		item, err := scanCalculationInterval(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) != len(ids) {
		return nil, fmt.Errorf("purge recalculation interval is missing")
	}
	return result, nil
}

func loadEstimationPlansTx(ctx context.Context, tx *sql.Tx, ids []string) ([]domain.EstimationPlanVersion, error) {
	result := make([]domain.EstimationPlanVersion, 0, len(ids))
	for _, id := range ids {
		var plan domain.EstimationPlanVersion
		var baseline int
		if err := tx.QueryRowContext(ctx, `SELECT pv.plan_version_id, pv.plan_id, p.is_baseline FROM plan_versions pv JOIN plans p ON p.plan_id = pv.plan_id WHERE pv.plan_version_id = ?`, id).Scan(&plan.ID, &plan.PlanID, &baseline); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, fmt.Errorf("read purge plan version: %w", err)
		}
		plan.IsBaseline = baseline != 0
		rows, err := tx.QueryContext(ctx, `SELECT plan_limit_rule_id, plan_version_id, limit_definition_id, plan_limit, limit_multiplier, official_source_url, created_at FROM plan_limit_rules WHERE plan_version_id = ? ORDER BY limit_definition_id, plan_limit_rule_id`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var rule domain.PlanLimitRule
			var limit, multiplier sql.NullFloat64
			var created string
			if err := rows.Scan(&rule.ID, &rule.PlanVersionID, &rule.LimitDefinitionID, &limit, &multiplier, &rule.OfficialSourceURL, &created); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if limit.Valid {
				value := limit.Float64
				rule.Limit = &value
			}
			if multiplier.Valid {
				value := multiplier.Float64
				rule.Multiplier = &value
			}
			rule.CreatedAt, err = parseUTC(created)
			if err != nil {
				_ = rows.Close()
				return nil, err
			}
			plan.LimitRules = append(plan.LimitRules, rule)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		result = append(result, plan)
	}
	return result, nil
}

func findPurgeCalculationInterval(intervals []domain.CalculationInterval, id string) (domain.CalculationInterval, error) {
	for _, interval := range intervals {
		if interval.ID == id {
			return interval, nil
		}
	}
	return domain.CalculationInterval{}, fmt.Errorf("purge recalculation interval %q was not found", id)
}

func saveDerivedResultTx(ctx context.Context, tx *sql.Tx, result domain.DerivedResult) error {
	if err := prepareDerivedResult(&result); err != nil {
		return err
	}
	if err := addPurgeResultEvidenceTx(ctx, tx, &result); err != nil {
		return err
	}
	if result.InputFingerprint == "" {
		fingerprint, err := domain.ComputeInputFingerprint(result.Points, result.DifferenceRows, result.Evidence, result.SeriesMultipliers, result.PlanLimitRuleIDs, result.MatchingRuleVersion, result.CalculationLogicVersion, result.PlanLimitRules...)
		if err != nil {
			return err
		}
		result.InputFingerprint = fingerprint
	}
	var oldID string
	err := tx.QueryRowContext(ctx, `SELECT estimation_result_id FROM estimation_results WHERE result_set_key = ?`, result.ResultSetKey).Scan(&oldID)
	if errors.Is(err, sql.ErrNoRows) {
		oldID = ""
	} else if err != nil {
		return fmt.Errorf("read purge existing result: %w", err)
	}
	if oldID != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM estimation_results WHERE estimation_result_id = ?`, oldID); err != nil {
			return fmt.Errorf("replace purge result: %w", err)
		}
	}
	reasons, err := jsonArray(result.Reasons)
	if err != nil {
		return err
	}
	limits, err := jsonArray(result.Limits)
	if err != nil {
		return err
	}
	intervalIDs, err := jsonArray(sortedUnique(result.CalculationIntervalIDs))
	if err != nil {
		return err
	}
	matchingVersion := result.MatchingRuleVersion
	if matchingVersion == "" && len(result.Points) > 0 {
		matchingVersion = result.Points[0].MatchingRuleVersion
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, result.ID, result.ResultSetKey, result.ServiceID, result.LimitDefinitionID, result.CycleType, string(intervalIDs), utcText(result.ValidFrom), utcText(result.ValidTo), result.Status, string(reasons), string(limits), len(result.Points), len(result.DifferenceRows), result.Rank, result.AbsoluteErrorRatio, result.MaxTimeDelta.Nanoseconds(), result.CalculationLogicVersion, matchingVersion, result.InputFingerprint, utcText(result.CreatedAt), utcText(result.UpdatedAt)); err != nil {
		return fmt.Errorf("insert purge result: %w", err)
	}
	for _, series := range result.Series {
		if series.ID == "" {
			series.ID = uuid.NewString()
		}
		ruleIDs, err := jsonArray(sortedUnique(series.PlanLimitRuleIDs))
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO estimation_result_series (estimation_result_series_id, estimation_result_id, usage_limit_source_id, logical_account_id, plan_version_id, calculation_interval_id, multiplier, estimated_limit, plan_limit_rule_id, plan_limit_rule_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, series.ID, result.ID, series.UsageLimitSourceID, series.LogicalAccountID, series.PlanVersionID, series.CalculationIntervalID, series.Multiplier, series.EstimatedLimit, series.PlanLimitRuleID, string(ruleIDs)); err != nil {
			return fmt.Errorf("insert purge result series: %w", err)
		}
	}
	for index, row := range result.DifferenceRows {
		if row.ID == "" {
			row.ID = uuid.NewString()
		}
		coefficients, err := jsonArray(row.Coefficients)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO estimation_result_difference_rows (estimation_result_difference_row_id, estimation_result_id, row_index, start_point_id, end_point_id, start_at, end_at, coefficients_json, cost, accepted, exclusion_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.ID, result.ID, index, row.StartPointID, row.EndPointID, utcText(row.StartAt), utcText(row.EndAt), string(coefficients), row.Cost, boolInt(row.Accepted), row.ExclusionReason); err != nil {
			return fmt.Errorf("insert purge difference row: %w", err)
		}
	}
	seenIDs := make(map[string]struct{}, len(result.Evidence))
	for _, evidence := range result.Evidence {
		if evidence.ID == "" {
			evidence.ID = uuid.NewString()
		}
		id := evidence.ID
		for suffix := 2; ; suffix++ {
			if _, exists := seenIDs[id]; !exists {
				break
			}
			id = fmt.Sprintf("%s:%d", evidence.ID, suffix)
		}
		seenIDs[id] = struct{}{}
		if _, err := tx.ExecContext(ctx, `INSERT INTO estimation_result_evidence (estimation_result_evidence_id, estimation_result_id, evidence_kind, point_id, source_id, observation_id, snapshot_id, association_id, completeness_id, plan_history_id, logical_account_id, plan_version_id, observed_at, time_delta_ns, normalization_generation, normalization_rule_version, normalization_logic_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, result.ID, evidence.Kind, evidence.PointID, evidence.SourceID, evidence.ObservationID, evidence.SnapshotID, evidence.AssociationID, evidence.CompletenessID, evidence.PlanHistoryID, evidence.LogicalAccountID, evidence.PlanVersionID, nullableTimeText(evidence.ObservedAt), evidence.TimeDelta.Nanoseconds(), evidence.NormalizationGeneration, evidence.NormalizationRuleVersion, evidence.NormalizationLogicVersion, normalizedDetails(evidence.DetailsJSON)); err != nil {
			return fmt.Errorf("insert purge evidence: %w", err)
		}
	}
	return nil
}

func addPurgeResultEvidenceTx(ctx context.Context, tx *sql.Tx, result *domain.DerivedResult) error {
	result.Evidence = appendResultEvidence(result.Evidence, result.Points)
	seen := make(map[string]struct{}, len(result.Evidence))
	for _, item := range result.Evidence {
		seen[evidenceKey(item)] = struct{}{}
	}
	for _, item := range append([]domain.EstimationEvidence(nil), result.Evidence...) {
		if item.Kind != "matched_observation" || item.ObservationID == "" {
			continue
		}
		var snapshotID string
		err := tx.QueryRowContext(ctx, `SELECT snapshot_id FROM usage_limit_observations WHERE observation_id = ? UNION ALL SELECT snapshot_id FROM usage_cost_observations WHERE observation_id = ? LIMIT 1`, item.ObservationID, item.ObservationID).Scan(&snapshotID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("find purge evidence snapshot: %w", err)
		}
		evidence := domain.EstimationEvidence{ID: "snapshot:" + item.PointID + ":" + snapshotID, Kind: "snapshot", PointID: item.PointID, SnapshotID: snapshotID}
		key := evidenceKey(evidence)
		if _, exists := seen[key]; !exists {
			result.Evidence = append(result.Evidence, evidence)
			seen[key] = struct{}{}
		}
	}
	for _, point := range result.Points {
		for index, accountID := range point.LimitSeriesLogicalAccountIDs {
			if index >= len(point.LimitSeriesPlanVersionIDs) || accountID == "" || point.LimitSeriesPlanVersionIDs[index] == "" {
				continue
			}
			rows, err := tx.QueryContext(ctx, `SELECT plan_history_id, valid_from, valid_to FROM plan_histories WHERE logical_account_id = ? AND plan_version_id = ? AND valid_from < ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY valid_from, plan_history_id`, accountID, point.LimitSeriesPlanVersionIDs[index], utcText(result.ValidTo), utcText(result.ValidFrom))
			if err != nil {
				return err
			}
			for rows.Next() {
				var id, from string
				var to sql.NullString
				if err := rows.Scan(&id, &from, &to); err != nil {
					_ = rows.Close()
					return err
				}
				evidence := domain.EstimationEvidence{ID: "plan-history:" + point.ID + ":" + id, Kind: "plan_history", PointID: point.ID, PlanHistoryID: id, LogicalAccountID: accountID, PlanVersionID: point.LimitSeriesPlanVersionIDs[index], DetailsJSON: `{"validFrom":"` + from + `","validTo":"` + to.String + `"}`}
				key := evidenceKey(evidence)
				if _, exists := seen[key]; !exists {
					result.Evidence = append(result.Evidence, evidence)
					seen[key] = struct{}{}
				}
			}
			if err := rows.Close(); err != nil {
				return err
			}
		}
	}
	return nil
}
