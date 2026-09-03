package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

// RecalculationRequest is the durable worker lease. ScopeJSON is intentionally
// opaque to the persistence layer; the worker owns its interpretation.
type RecalculationRequest = domain.RecalculationRequest

// SaveDerivedResult replaces one result set atomically. It never calls
// SaveCalculationIntervals: result persistence is an internal transaction
// path used by the recalculation worker.
func (l *Lifecycle) SaveDerivedResult(ctx context.Context, result domain.DerivedResult, injector FailureInjector) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	if err := prepareDerivedResult(&result); err != nil {
		return err
	}
	if err := l.enrichDerivedResultEvidence(ctx, database, &result); err != nil {
		return err
	}
	if result.InputFingerprint == "" {
		multipliers, ruleIDs := result.SeriesMultipliers, result.PlanLimitRuleIDs
		if len(multipliers) == 0 {
			for _, series := range result.Series {
				if series.Multiplier != nil {
					multipliers = append(multipliers, *series.Multiplier)
				}
				if series.PlanLimitRuleID != "" {
					ruleIDs = append(ruleIDs, series.PlanLimitRuleID)
				}
			}
		}
		fingerprint, err := domain.ComputeInputFingerprint(result.Points, result.DifferenceRows, result.Evidence, multipliers, ruleIDs, result.MatchingRuleVersion, result.CalculationLogicVersion, result.PlanLimitRules...)
		if err != nil {
			return err
		}
		result.InputFingerprint = fingerprint
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin derived result replacement: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var oldID string
	err = tx.QueryRowContext(ctx, `SELECT estimation_result_id FROM estimation_results WHERE result_set_key = ?`, result.ResultSetKey).Scan(&oldID)
	if errors.Is(err, sql.ErrNoRows) {
		oldID = ""
	} else if err != nil {
		return fmt.Errorf("read existing estimation result: %w", err)
	}
	if oldID != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM estimation_results WHERE estimation_result_id = ?`, oldID); err != nil {
			return fmt.Errorf("replace existing estimation result: %w", err)
		}
	}
	if err := inject(injector, "after-old-result-delete"); err != nil {
		return err
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
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO estimation_results
			(estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type,
			 calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json,
			 observation_point_count, difference_row_count, rank, max_time_delta_ns,
			 calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		result.ID, result.ResultSetKey, result.ServiceID, result.LimitDefinitionID, result.CycleType,
		string(intervalIDs), catalogPeriodText(result.ValidFrom), catalogPeriodText(result.ValidTo), result.Status, string(reasons), string(limits),
		len(result.Points), len(result.DifferenceRows), result.Rank, result.MaxTimeDelta.Nanoseconds(),
		result.CalculationLogicVersion, matchingVersion, result.InputFingerprint, utcText(result.CreatedAt), utcText(result.UpdatedAt)); err != nil {
		return fmt.Errorf("insert estimation result: %w", err)
	}
	if err := inject(injector, "after-result"); err != nil {
		return err
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
			return fmt.Errorf("insert estimation result series: %w", err)
		}
	}
	if err := inject(injector, "after-series"); err != nil {
		return err
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
			return fmt.Errorf("insert estimation difference row: %w", err)
		}
	}
	if err := inject(injector, "after-difference-rows"); err != nil {
		return err
	}
	evidenceIDs := make(map[string]int, len(result.Evidence))
	for _, evidence := range result.Evidence {
		if evidence.ID == "" {
			evidence.ID = uuid.NewString()
		}
		baseID := evidence.ID
		count := evidenceIDs[baseID]
		if count > 0 {
			for {
				count++
				candidate := fmt.Sprintf("%s:%d", baseID, count)
				if evidenceIDs[candidate] == 0 {
					evidence.ID = candidate
					break
				}
			}
		}
		evidenceIDs[baseID] = count + 1
		evidenceIDs[evidence.ID]++
		if _, err := tx.ExecContext(ctx, `INSERT INTO estimation_result_evidence (estimation_result_evidence_id, estimation_result_id, evidence_kind, point_id, source_id, observation_id, snapshot_id, association_id, completeness_id, plan_history_id, logical_account_id, plan_version_id, observed_at, time_delta_ns, normalization_generation, normalization_rule_version, normalization_logic_version, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, evidence.ID, result.ID, evidence.Kind, evidence.PointID, evidence.SourceID, evidence.ObservationID, evidence.SnapshotID, evidence.AssociationID, evidence.CompletenessID, evidence.PlanHistoryID, evidence.LogicalAccountID, evidence.PlanVersionID, nullableTimeText(evidence.ObservedAt), evidence.TimeDelta.Nanoseconds(), evidence.NormalizationGeneration, evidence.NormalizationRuleVersion, evidence.NormalizationLogicVersion, normalizedDetails(evidence.DetailsJSON)); err != nil {
			return fmt.Errorf("insert estimation evidence: %w", err)
		}
	}
	if err := inject(injector, "after-evidence"); err != nil {
		return err
	}
	if err := inject(injector, "before-commit"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit derived result replacement: %w", err)
	}
	return nil
}

func prepareDerivedResult(result *domain.DerivedResult) error {
	if result == nil {
		return errors.New("derived result is required")
	}
	if len(result.Points) > 0 {
		first := result.Points[0]
		if result.ServiceID == "" {
			result.ServiceID = first.ServiceID
		}
		if result.LimitDefinitionID == "" {
			result.LimitDefinitionID = first.LimitDefinitionID
		}
		if result.CycleType == "" {
			result.CycleType = first.CycleType
		}
		if len(result.CalculationIntervalIDs) == 0 {
			result.CalculationIntervalIDs = append([]string(nil), first.CalculationIntervalIDs...)
		}
		if result.CalculationLogicVersion == "" {
			result.CalculationLogicVersion = first.CalculationLogicVersion
		}
		if result.MatchingRuleVersion == "" {
			result.MatchingRuleVersion = first.MatchingRuleVersion
		}
	}
	if len(result.CalculationIntervalIDs) == 0 && len(result.Intervals) > 0 {
		for _, interval := range result.Intervals {
			result.CalculationIntervalIDs = append(result.CalculationIntervalIDs, interval.ID)
		}
	}
	result.CalculationIntervalIDs = sortedUnique(result.CalculationIntervalIDs)
	if len(result.CalculationIntervalIDs) == 0 {
		return errors.New("derived result requires calculation interval IDs")
	}
	if result.ValidFrom.IsZero() || result.ValidTo.IsZero() {
		for _, interval := range result.Intervals {
			if result.ValidFrom.IsZero() || interval.ValidFrom.Before(result.ValidFrom) {
				result.ValidFrom = interval.ValidFrom
			}
			if result.ValidTo.IsZero() || interval.ValidTo.After(result.ValidTo) {
				result.ValidTo = interval.ValidTo
			}
		}
	}
	if result.ID == "" {
		result.ID = uuid.NewString()
	}
	if result.CreatedAt.IsZero() {
		result.CreatedAt = time.Now().UTC()
	}
	if result.UpdatedAt.IsZero() {
		result.UpdatedAt = result.CreatedAt
	}
	if result.Status == "" {
		return errors.New("derived result status is required")
	}
	if strings.TrimSpace(result.ServiceID) == "" || strings.TrimSpace(result.LimitDefinitionID) == "" || strings.TrimSpace(result.CycleType) == "" || result.ValidFrom.IsZero() || result.ValidTo.IsZero() || !result.ValidFrom.Before(result.ValidTo) {
		return errors.New("derived result identity and period are required")
	}
	canonicalKey := domain.ResultSetKey(result.ServiceID, result.LimitDefinitionID, result.CycleType, result.ValidFrom, result.ValidTo, result.CalculationIntervalIDs)
	if result.ResultSetKey == "" {
		result.ResultSetKey = canonicalKey
	} else if result.ResultSetKey != canonicalKey {
		return errors.New("derived result set key does not match its identity")
	}
	if len(result.Series) == 0 {
		for i, sourceID := range result.LimitSeriesIDs {
			series := domain.EstimationResultSeries{UsageLimitSourceID: sourceID}
			if i < len(result.LimitSeriesLogicalAccountIDs) {
				series.LogicalAccountID = result.LimitSeriesLogicalAccountIDs[i]
			}
			if i < len(result.LimitSeriesPlanVersionIDs) {
				series.PlanVersionID = result.LimitSeriesPlanVersionIDs[i]
			}
			if i < len(result.LimitSeriesCalculationIntervalIDs) {
				series.CalculationIntervalID = result.LimitSeriesCalculationIntervalIDs[i]
			}
			if i < len(result.SeriesMultipliers) {
				value := result.SeriesMultipliers[i]
				series.Multiplier = &value
			}
			if i < len(result.SeriesLimits) {
				value := result.SeriesLimits[i]
				series.EstimatedLimit = &value
			} else if len(result.Limits) == 1 && series.Multiplier != nil {
				value := result.Limits[0] * *series.Multiplier
				series.EstimatedLimit = &value
			}
			if i < len(result.PlanLimitRuleIDs) {
				series.PlanLimitRuleID = result.PlanLimitRuleIDs[i]
			}
			if i < len(result.SeriesPlanLimitRuleIDs) {
				series.PlanLimitRuleIDs = sortedUnique(result.SeriesPlanLimitRuleIDs[i])
			}
			result.Series = append(result.Series, series)
		}
	}
	result.Evidence = appendResultEvidence(result.Evidence, result.Points)
	return nil
}

func appendResultEvidence(existing []domain.EstimationEvidence, points []domain.EstimationPoint) []domain.EstimationEvidence {
	seen := make(map[string]struct{}, len(existing))
	result := append([]domain.EstimationEvidence(nil), existing...)
	for _, item := range result {
		seen[evidenceKey(item)] = struct{}{}
	}
	add := func(item domain.EstimationEvidence) {
		if item.ID == "" {
			item.ID = uuid.NewString()
		}
		key := evidenceKey(item)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		result = append(result, item)
	}
	for _, point := range points {
		add(domain.EstimationEvidence{ID: "point:" + point.ID, Kind: "point", PointID: point.ID, LogicalAccountID: firstString(point.LimitSeriesLogicalAccountIDs), PlanVersionID: firstString(point.LimitSeriesPlanVersionIDs), ObservedAt: point.ReferenceAt})
		for _, item := range point.MatchedObservations {
			add(domain.EstimationEvidence{ID: "matched:" + point.ID + ":" + item.ID, Kind: "matched_observation", PointID: point.ID, SourceID: item.SourceID, ObservationID: item.ObservationID, LogicalAccountID: item.LogicalAccountID, ObservedAt: item.ObservedAt, TimeDelta: item.TimeDelta, NormalizationGeneration: item.NormalizationGeneration, NormalizationRuleVersion: item.NormalizationRuleVersion, NormalizationLogicVersion: item.NormalizationLogicVersion})
		}
		for _, id := range sortedUnique(point.AssociationIDs) {
			add(domain.EstimationEvidence{ID: "association:" + point.ID + ":" + id, Kind: "association", PointID: point.ID, AssociationID: id})
		}
		for _, id := range sortedUnique(point.CompletenessIDs) {
			add(domain.EstimationEvidence{ID: "completeness:" + point.ID + ":" + id, Kind: "completeness", PointID: point.ID, CompletenessID: id})
		}
	}
	return result
}

func (l *Lifecycle) enrichDerivedResultEvidence(ctx context.Context, database *sql.DB, result *domain.DerivedResult) (err error) {
	seen := make(map[string]struct{}, len(result.Evidence))
	for _, item := range result.Evidence {
		seen[evidenceKey(item)] = struct{}{}
	}
	add := func(item domain.EstimationEvidence) {
		key := evidenceKey(item)
		if _, ok := seen[key]; ok {
			return
		}
		if item.ID == "" {
			item.ID = uuid.NewString()
		}
		seen[key] = struct{}{}
		result.Evidence = append(result.Evidence, item)
	}
	for _, item := range append([]domain.EstimationEvidence(nil), result.Evidence...) {
		if item.Kind != "matched_observation" || item.ObservationID == "" || item.SnapshotID != "" {
			continue
		}
		var snapshotID string
		err := database.QueryRowContext(ctx, `SELECT snapshot_id FROM usage_limit_observations WHERE observation_id = ? UNION ALL SELECT snapshot_id FROM usage_cost_observations WHERE observation_id = ? LIMIT 1`, item.ObservationID, item.ObservationID).Scan(&snapshotID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return fmt.Errorf("find estimation evidence snapshot: %w", err)
		}
		item.SnapshotID = snapshotID
		item.ID = "snapshot:" + item.PointID + ":" + snapshotID
		item.Kind = "snapshot"
		item.ObservationID = ""
		add(item)
	}
	for _, point := range result.Points {
		for index, accountID := range point.LimitSeriesLogicalAccountIDs {
			if index >= len(point.LimitSeriesPlanVersionIDs) || accountID == "" || point.LimitSeriesPlanVersionIDs[index] == "" {
				continue
			}
			rows, err := database.QueryContext(ctx, `SELECT plan_history_id, valid_from, valid_to FROM plan_histories WHERE logical_account_id = ? AND plan_version_id = ? AND valid_from < ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY valid_from, plan_history_id`, accountID, point.LimitSeriesPlanVersionIDs[index], utcText(result.ValidTo), utcText(result.ValidFrom))
			if err != nil {
				return fmt.Errorf("find estimation plan history evidence: %w", err)
			}
			defer func() {
				if closeErr := rows.Close(); closeErr != nil && err == nil {
					err = fmt.Errorf("close estimation plan history evidence rows: %w", closeErr)
				}
			}()
			for rows.Next() {
				var id, from string
				var to sql.NullString
				if err := rows.Scan(&id, &from, &to); err != nil {
					return err
				}
				add(domain.EstimationEvidence{ID: "plan-history:" + point.ID + ":" + id, Kind: "plan_history", PointID: point.ID, PlanHistoryID: id, LogicalAccountID: accountID, PlanVersionID: point.LimitSeriesPlanVersionIDs[index], DetailsJSON: `{"validFrom":"` + from + `","validTo":"` + to.String + `"` + `}`})
			}
			if err := rows.Err(); err != nil {
				return fmt.Errorf("read estimation plan history evidence: %w", err)
			}
		}
	}
	return nil
}

func evidenceKey(item domain.EstimationEvidence) string {
	return strings.Join([]string{item.Kind, item.PointID, item.SourceID, item.ObservationID, item.SnapshotID, item.AssociationID, item.CompletenessID, item.PlanHistoryID}, "|")
}

func (l *Lifecycle) ListEstimationResults(ctx context.Context, serviceID string) (result []domain.DerivedResult, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at FROM estimation_results`
	args := []any{}
	if strings.TrimSpace(serviceID) != "" {
		query += ` WHERE service_id = ?`
		args = append(args, serviceID)
	}
	query += ` ORDER BY valid_from, result_set_key`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list estimation results: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close estimation result rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		item, err := scanDerivedResultRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read estimation results: %w", err)
	}
	for index := range result {
		if err := l.loadDerivedResultChildren(ctx, database, &result[index]); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (l *Lifecycle) GetEstimationResult(ctx context.Context, resultSetKey string) (domain.DerivedResult, error) {
	database, err := l.DB()
	if err != nil {
		return domain.DerivedResult{}, err
	}
	row := database.QueryRowContext(ctx, `SELECT estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at FROM estimation_results WHERE result_set_key = ?`, resultSetKey)
	item, err := scanDerivedResultRow(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.DerivedResult{}, errors.New("estimation result was not found")
		}
		return domain.DerivedResult{}, err
	}
	if err := l.loadDerivedResultChildren(ctx, database, &item); err != nil {
		return domain.DerivedResult{}, err
	}
	return item, nil
}

func scanDerivedResultRow(scanner rowScanner) (domain.DerivedResult, error) {
	var item domain.DerivedResult
	var intervalJSON, reasonsJSON, limitsJSON string
	var from, to, created, updated string
	var maxDelta int64
	if err := scanner.Scan(&item.ID, &item.ResultSetKey, &item.ServiceID, &item.LimitDefinitionID, &item.CycleType, &intervalJSON, &from, &to, &item.Status, &reasonsJSON, &limitsJSON, &item.Rows, &item.DifferenceRowCount, &item.Rank, &maxDelta, &item.CalculationLogicVersion, &item.MatchingRuleVersion, &item.InputFingerprint, &created, &updated); err != nil {
		return domain.DerivedResult{}, err
	}
	if err := json.Unmarshal([]byte(intervalJSON), &item.CalculationIntervalIDs); err != nil {
		return item, fmt.Errorf("decode estimation result interval IDs: %w", err)
	}
	if err := json.Unmarshal([]byte(reasonsJSON), &item.Reasons); err != nil {
		return item, fmt.Errorf("decode estimation result reasons: %w", err)
	}
	if err := json.Unmarshal([]byte(limitsJSON), &item.Limits); err != nil {
		return item, fmt.Errorf("decode estimation result limits: %w", err)
	}
	var err error
	item.ValidFrom, err = parseUTC(from)
	if err != nil {
		return item, err
	}
	item.ValidTo, err = parseUTC(to)
	if err != nil {
		return item, err
	}
	item.CreatedAt, err = parseUTC(created)
	if err != nil {
		return item, err
	}
	item.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return item, err
	}
	item.MaxTimeDelta = time.Duration(maxDelta)
	return item, nil
}

func (l *Lifecycle) loadDerivedResultChildren(ctx context.Context, database *sql.DB, result *domain.DerivedResult) (err error) {
	seriesRows, err := database.QueryContext(ctx, `SELECT estimation_result_series_id, usage_limit_source_id, logical_account_id, plan_version_id, calculation_interval_id, multiplier, estimated_limit, plan_limit_rule_id, plan_limit_rule_ids_json FROM estimation_result_series WHERE estimation_result_id = ? ORDER BY usage_limit_source_id, logical_account_id, plan_version_id`, result.ID)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := seriesRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close estimation result series rows: %w", closeErr)
		}
	}()
	for seriesRows.Next() {
		var item domain.EstimationResultSeries
		var ruleIDs string
		var multiplier, estimatedLimit sql.NullFloat64
		if err := seriesRows.Scan(&item.ID, &item.UsageLimitSourceID, &item.LogicalAccountID, &item.PlanVersionID, &item.CalculationIntervalID, &multiplier, &estimatedLimit, &item.PlanLimitRuleID, &ruleIDs); err != nil {
			return err
		}
		if multiplier.Valid {
			value := multiplier.Float64
			item.Multiplier = &value
		}
		if estimatedLimit.Valid {
			value := estimatedLimit.Float64
			item.EstimatedLimit = &value
		}
		if err := json.Unmarshal([]byte(ruleIDs), &item.PlanLimitRuleIDs); err != nil {
			return err
		}
		result.Series = append(result.Series, item)
	}
	if err := seriesRows.Err(); err != nil {
		return fmt.Errorf("read estimation result series: %w", err)
	}
	differenceRows, err := database.QueryContext(ctx, `SELECT estimation_result_difference_row_id, start_point_id, end_point_id, start_at, end_at, coefficients_json, cost, accepted, exclusion_reason FROM estimation_result_difference_rows WHERE estimation_result_id = ? ORDER BY row_index`, result.ID)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := differenceRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close estimation result difference rows: %w", closeErr)
		}
	}()
	for differenceRows.Next() {
		var item domain.EstimationDifferenceRow
		var start, end, coefficients string
		var accepted int
		if err := differenceRows.Scan(&item.ID, &item.StartPointID, &item.EndPointID, &start, &end, &coefficients, &item.Cost, &accepted, &item.ExclusionReason); err != nil {
			return err
		}
		item.StartAt, err = parseUTC(start)
		if err != nil {
			return err
		}
		item.EndAt, err = parseUTC(end)
		if err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(coefficients), &item.Coefficients); err != nil {
			return err
		}
		item.Accepted = accepted != 0
		result.DifferenceRows = append(result.DifferenceRows, item)
	}
	if err := differenceRows.Err(); err != nil {
		return fmt.Errorf("read estimation result difference rows: %w", err)
	}
	evidenceRows, err := database.QueryContext(ctx, `SELECT estimation_result_evidence_id, evidence_kind, point_id, source_id, observation_id, snapshot_id, association_id, completeness_id, plan_history_id, logical_account_id, plan_version_id, observed_at, time_delta_ns, normalization_generation, normalization_rule_version, normalization_logic_version, details_json FROM estimation_result_evidence WHERE estimation_result_id = ? ORDER BY evidence_kind, estimation_result_evidence_id`, result.ID)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := evidenceRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close estimation result evidence rows: %w", closeErr)
		}
	}()
	for evidenceRows.Next() {
		var item domain.EstimationEvidence
		var observed sql.NullString
		var delta int64
		if err := evidenceRows.Scan(&item.ID, &item.Kind, &item.PointID, &item.SourceID, &item.ObservationID, &item.SnapshotID, &item.AssociationID, &item.CompletenessID, &item.PlanHistoryID, &item.LogicalAccountID, &item.PlanVersionID, &observed, &delta, &item.NormalizationGeneration, &item.NormalizationRuleVersion, &item.NormalizationLogicVersion, &item.DetailsJSON); err != nil {
			return err
		}
		item.TimeDelta = time.Duration(delta)
		if observed.Valid {
			item.ObservedAt, err = parseUTC(observed.String)
			if err != nil {
				return err
			}
		}
		result.Evidence = append(result.Evidence, item)
	}
	if err := evidenceRows.Err(); err != nil {
		return fmt.Errorf("read estimation result evidence: %w", err)
	}
	return nil
}

// ListFallbackResults returns only the newest eligible result for each
// account/plan pair. No age cutoff is applied.
func (l *Lifecycle) ListFallbackResults(ctx context.Context, serviceID, definitionID, cycle string, currentFrom time.Time) (result []domain.FallbackResult, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT r.estimation_result_id, s.estimation_result_series_id, s.logical_account_id, s.plan_version_id, r.valid_from, r.valid_to, r.status FROM estimation_results r JOIN estimation_result_series s ON s.estimation_result_id = r.estimation_result_id WHERE r.service_id = ? AND r.limit_definition_id = ? AND r.cycle_type = ? AND r.status = 'estimated' AND r.valid_to <= ? ORDER BY s.logical_account_id, s.plan_version_id, r.valid_to DESC, r.estimation_result_id DESC`, serviceID, definitionID, cycle, utcText(currentFrom))
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close fallback result rows: %w", closeErr)
		}
	}()
	seen := map[string]struct{}{}
	for rows.Next() {
		var item domain.FallbackResult
		var from, to, status string
		if err := rows.Scan(&item.ResultID, &item.SeriesID, &item.LogicalAccountID, &item.PlanVersionID, &from, &to, &status); err != nil {
			return nil, err
		}
		item.ValidFrom, err = parseUTC(from)
		if err != nil {
			return nil, err
		}
		item.ValidTo, err = parseUTC(to)
		if err != nil {
			return nil, err
		}
		item.Age = currentFrom.Sub(item.ValidTo)
		item.Status = domain.EstimationStatus(status)
		key := item.LogicalAccountID + "|" + item.PlanVersionID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (l *Lifecycle) ClaimRecalculationRequest(ctx context.Context, workerID string) (RecalculationRequest, bool, error) {
	if strings.TrimSpace(workerID) == "" {
		return RecalculationRequest{}, false, errors.New("recalculation worker ID is required")
	}
	database, err := l.DB()
	if err != nil {
		return RecalculationRequest{}, false, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return RecalculationRequest{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	var request RecalculationRequest
	var requested, start, end, scope string
	var last, ignoredClaimedBy, ignoredClaimedAt sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT request_id, audit_id, requested_at, interval_start, interval_end, scope_json, state, last_error, claimed_by, claimed_at FROM recalculation_requests WHERE state = 'pending' ORDER BY requested_at, request_id LIMIT 1`).Scan(&request.RequestID, &request.AuditID, &requested, &start, &end, &scope, &request.State, &last, &ignoredClaimedBy, &ignoredClaimedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RecalculationRequest{}, false, nil
	}
	if err != nil {
		return RecalculationRequest{}, false, err
	}
	now := time.Now().UTC()
	result, err := tx.ExecContext(ctx, `UPDATE recalculation_requests SET state = 'running', claimed_by = ?, claimed_at = ? WHERE request_id = ? AND state = 'pending'`, workerID, utcText(now), request.RequestID)
	if err != nil {
		return RecalculationRequest{}, false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		return RecalculationRequest{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return RecalculationRequest{}, false, err
	}
	request.State = "running"
	request.ClaimedBy = workerID
	request.ClaimedAt = &now
	request.RequestedAt, err = parseUTC(requested)
	if err != nil {
		return request, false, err
	}
	request.IntervalStart, err = parseUTC(start)
	if err != nil {
		return request, false, err
	}
	request.IntervalEnd, err = parseUTC(end)
	if err != nil {
		return request, false, err
	}
	request.ScopeJSON = scope
	request.LastError = last.String
	return request, true, nil
}

func (l *Lifecycle) CompleteRecalculationRequest(ctx context.Context, requestID string) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `UPDATE recalculation_requests SET state = 'succeeded', last_error = NULL WHERE request_id = ? AND state = 'running'`, requestID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return errors.New("recalculation request is not running")
	}
	return nil
}
func (l *Lifecycle) FailRecalculationRequest(ctx context.Context, requestID, failure string) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `UPDATE recalculation_requests SET state = 'failed', last_error = ? WHERE request_id = ? AND state = 'running'`, failure, requestID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return errors.New("recalculation request is not running")
	}
	return nil
}

// Recalculate executes only the derived-result path. Calculation intervals and
// source facts are immutable inputs here; the worker never invokes their save
// operation.
func (l *Lifecycle) Recalculate(ctx context.Context, request domain.RecalculationRequest) (err error) {
	scope, err := domain.DecodeRecalculationScope(request.ScopeJSON)
	if err != nil {
		return err
	}
	intervalIDs := []string{}
	database, err := l.DB()
	if err != nil {
		return err
	}
	if len(scope.CostSourceIDs) != 0 && len(scope.ServiceIDs) == 0 && len(scope.DefinitionIDs) == 0 && len(scope.AccountIDs) == 0 && len(scope.LimitSourceIDs) == 0 && len(scope.IntervalIDs) == 0 {
		return nil
	}

	servicesToBuild := append([]string(nil), scope.ServiceIDs...)
	if len(servicesToBuild) == 0 && len(scope.IntervalIDs) == 0 {
		for _, accountID := range scope.AccountIDs {
			var sid string
			if err := database.QueryRowContext(ctx, `SELECT service_id FROM logical_accounts WHERE logical_account_id = ?`, accountID).Scan(&sid); err == nil && sid != "" {
				servicesToBuild = append(servicesToBuild, sid)
			}
		}
		for _, defID := range scope.DefinitionIDs {
			var sid string
			if err := database.QueryRowContext(ctx, `SELECT service_id FROM limit_definitions WHERE limit_definition_id = ?`, defID).Scan(&sid); err == nil && sid != "" {
				servicesToBuild = append(servicesToBuild, sid)
			}
		}
		for _, sourceID := range scope.LimitSourceIDs {
			var sid string
			if err := database.QueryRowContext(ctx, `SELECT la.service_id FROM usage_limit_source_links l JOIN logical_accounts la ON la.logical_account_id = l.logical_account_id WHERE l.usage_limit_source_id = ? LIMIT 1`, sourceID).Scan(&sid); err == nil && sid != "" {
				servicesToBuild = append(servicesToBuild, sid)
			}
		}
	}
	servicesToBuild = sortedUnique(servicesToBuild)
	now := time.Now().UTC()
	for _, serviceID := range servicesToBuild {
		buildReq := domain.CalculationBuildRequest{
			ServiceID: serviceID,
			ValidFrom: time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
			ValidTo:   now.Add(30 * 24 * time.Hour),
		}
		series, err := l.ListCalculationSeries(ctx, buildReq)
		if err != nil {
			continue
		}
		var intervals []CalculationInterval
		var boundaries []CalculationBoundary
		for _, item := range series {
			derived, derivedBoundaries, err := domain.DeriveCalculationIntervals(item, buildReq, uuid.NewString, now)
			if err != nil {
				continue
			}
			intervals = append(intervals, derived...)
			boundaries = append(boundaries, derivedBoundaries...)
		}
		if len(intervals) > 0 || len(boundaries) > 0 {
			tx, err := database.BeginTx(ctx, nil)
			if err == nil {
				if err := saveCalculationIntervalsTx(ctx, tx, intervals, boundaries, false); err == nil {
					_ = tx.Commit()
				} else {
					_ = tx.Rollback()
				}
			}
		}
		matchingInputs, mErr := l.ListCalculationMatchingInputs(ctx, buildReq)
		if mErr == nil {
			var allPoints []domain.EstimationPoint
			for _, input := range matchingInputs {
				derivedPoints, pErr := domain.BuildEstimationPoints(input, uuid.NewString, now)
				if pErr == nil {
					allPoints = append(allPoints, derivedPoints...)
				}
			}
			if len(allPoints) > 0 {
				_ = l.SaveEstimationPoints(ctx, allPoints)
			}
		}
	}

	conditions := []string{"valid_from < ?", "? < valid_to"}
	args := []any{catalogPeriodText(request.IntervalEnd), catalogPeriodText(request.IntervalStart)}
	for _, filter := range []struct {
		values []string
		column string
	}{
		{values: scope.ServiceIDs, column: "service_id"},
		{values: scope.DefinitionIDs, column: "limit_definition_id"},
		{values: scope.AccountIDs, column: "logical_account_id"},
		{values: scope.LimitSourceIDs, column: "usage_limit_source_id"},
		{values: scope.IntervalIDs, column: "calculation_interval_id"},
	} {
		if len(filter.values) == 0 {
			continue
		}
		placeholders := make([]string, len(filter.values))
		for index, value := range filter.values {
			placeholders[index] = "?"
			args = append(args, value)
		}
		conditions = append(conditions, filter.column+" IN ("+strings.Join(placeholders, ",")+")")
	}
	query := `SELECT calculation_interval_id FROM calculation_intervals WHERE ` + strings.Join(conditions, " AND ") + ` ORDER BY valid_from, calculation_interval_id`
	rows, queryErr := database.QueryContext(ctx, query, args...)
	if queryErr != nil {
		return fmt.Errorf("list recalculation intervals: %w", queryErr)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close recalculation interval rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			return scanErr
		}
		intervalIDs = append(intervalIDs, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read recalculation intervals: %w", err)
	}

	if len(intervalIDs) == 0 && len(scope.IntervalIDs) == 0 && len(servicesToBuild) > 0 {
		placeholders := make([]string, len(servicesToBuild))
		sArgs := make([]any, len(servicesToBuild))
		for i, sid := range servicesToBuild {
			placeholders[i] = "?"
			sArgs[i] = sid
		}
		fallbackQuery := `SELECT calculation_interval_id FROM calculation_intervals WHERE service_id IN (` + strings.Join(placeholders, ",") + `) AND state = 'estimable' ORDER BY valid_from DESC, calculation_interval_id LIMIT 10`
		fbRows, fbErr := database.QueryContext(ctx, fallbackQuery, sArgs...)
		if fbErr == nil {
			defer fbRows.Close()
			for fbRows.Next() {
				var id string
				if err := fbRows.Scan(&id); err == nil {
					intervalIDs = append(intervalIDs, id)
				}
			}
		}
	}
	for _, intervalID := range sortedUnique(intervalIDs) {
		if err := l.recalculateInterval(ctx, intervalID); err != nil {
			return err
		}
	}
	return nil
}

func (l *Lifecycle) recalculateInterval(ctx context.Context, intervalID string) error {
	allIntervals, err := l.ListCalculationIntervals(ctx, "")
	if err != nil {
		return err
	}
	interval, err := l.findCalculationInterval(allIntervals, intervalID)
	if err != nil {
		return err
	}

	points, err := l.rebuildEstimationPoints(ctx, interval)
	if err != nil {
		return err
	}
	input, err := l.estimationInputForPoints(ctx, intervalID, points)
	if err != nil {
		return err
	}
	estimate, err := domain.EstimateFromPoints(input)
	if err != nil {
		return fmt.Errorf("recalculate estimation result: %w", err)
	}
	now := time.Now().UTC()
	result := domain.DerivedResult{ID: uuid.NewString(), ServiceID: interval.ServiceID, LimitDefinitionID: interval.LimitDefinitionID, CycleType: interval.CycleType, CalculationIntervalIDs: []string{interval.ID}, ValidFrom: interval.ValidFrom, ValidTo: interval.ValidTo, EstimationResult: estimate, Points: points, Intervals: input.Intervals, Series: estimationResultSeries(input, estimate, interval), CreatedAt: now, UpdatedAt: now}
	if err := l.SaveDerivedResult(ctx, result, nil); err != nil {
		return err
	}
	return nil
}

func estimationResultSeries(input domain.EstimationInput, estimate domain.EstimationResult, interval domain.CalculationInterval) []domain.EstimationResultSeries {
	series := make([]domain.EstimationResultSeries, 0, len(input.Intervals))
	for index, item := range input.Intervals {
		var limit *float64
		if index < len(estimate.Limits) && estimate.Limits[index] > 0 {
			value := estimate.Limits[index]
			limit = &value
		}
		series = append(series, domain.EstimationResultSeries{
			ID:                    uuid.NewString(),
			UsageLimitSourceID:    item.UsageLimitSourceID,
			LogicalAccountID:      item.LogicalAccountID,
			PlanVersionID:         item.PlanVersionID,
			CalculationIntervalID: item.ID,
			EstimatedLimit:        limit,
		})
	}
	if len(series) == 0 {
		var limit *float64
		if len(estimate.Limits) > 0 && estimate.Limits[0] > 0 {
			value := estimate.Limits[0]
			limit = &value
		}
		series = append(series, domain.EstimationResultSeries{
			ID:                    uuid.NewString(),
			UsageLimitSourceID:    interval.UsageLimitSourceID,
			LogicalAccountID:      interval.LogicalAccountID,
			PlanVersionID:         interval.PlanVersionID,
			CalculationIntervalID: interval.ID,
			EstimatedLimit:        limit,
		})
	}
	return series
}

// rebuildEstimationPoints regenerates current calculation points from the
// immutable observations and associations. Persisted points are derived data,
// so a stale calculation logic version must never be relabeled in place.
func (l *Lifecycle) rebuildEstimationPoints(ctx context.Context, interval domain.CalculationInterval) ([]domain.EstimationPoint, error) {
	if interval.State != domain.CalculationEstimable {
		return nil, l.removeStaleEstimationPoints(ctx, interval.ID)
	}
	inputs, err := l.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: interval.ServiceID, ValidFrom: interval.ValidFrom, ValidTo: interval.ValidTo})
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	points := make([]domain.EstimationPoint, 0)
	for _, input := range inputs {
		containsInterval := false
		for _, id := range input.CalculationIntervalIDs {
			if id == interval.ID {
				containsInterval = true
				break
			}
		}
		if !containsInterval {
			continue
		}
		derived, err := domain.BuildEstimationPoints(input, uuid.NewString, now)
		if err != nil {
			return nil, fmt.Errorf("rebuild estimation points: %w", err)
		}
		points = append(points, derived...)
	}
	if len(points) > 0 {
		if err := l.SaveEstimationPoints(ctx, points); err != nil {
			return nil, err
		}
	}
	if err := l.removeStaleEstimationPoints(ctx, interval.ID); err != nil {
		return nil, err
	}
	return l.ListEstimationPoints(ctx, interval.ID)
}

func (l *Lifecycle) removeStaleEstimationPoints(ctx context.Context, intervalID string) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	if _, err := database.ExecContext(ctx, `
		DELETE FROM estimation_points
		WHERE calculation_logic_version <> ?
		  AND (calculation_interval_id = ? OR EXISTS (
			SELECT 1 FROM json_each(estimation_points.calculation_interval_ids_json) WHERE json_each.value = ?
		  ))`, domain.CalculationLogicVersion, intervalID, intervalID); err != nil {
		return fmt.Errorf("remove stale estimation points: %w", err)
	}
	return nil
}

func (l *Lifecycle) findCalculationInterval(intervals []domain.CalculationInterval, id string) (domain.CalculationInterval, error) {
	for _, interval := range intervals {
		if interval.ID == id {
			return interval, nil
		}
	}
	return domain.CalculationInterval{}, fmt.Errorf("recalculation interval %q was not found", id)
}

func jsonArray(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode estimation result JSON: %w", err)
	}
	if string(encoded) == "null" {
		return []byte("[]"), nil
	}
	return encoded, nil
}

func sortedUnique(values []string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
func nullableTimeText(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return utcText(value)
}
func normalizedDetails(value string) string {
	if strings.TrimSpace(value) == "" {
		return "{}"
	}
	return value
}

// RecalculateStaleDerivedResults recomputes any calculation intervals that lack an
// estimation result or have an estimation result with a stale CalculationLogicVersion.
func (l *Lifecycle) RecalculateStaleDerivedResults(ctx context.Context) (err error) {
	database, err := l.DB()
	if err != nil {
		return err
	}
	rows, queryErr := database.QueryContext(ctx, `
		SELECT ci.calculation_interval_id
		FROM calculation_intervals ci
		ORDER BY ci.valid_from, ci.calculation_interval_id
	`)
	if queryErr != nil {
		return fmt.Errorf("list calculation intervals for stale check: %w", queryErr)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close stale check rows: %w", closeErr)
		}
	}()
	var candidateIntervalIDs []string
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			return scanErr
		}
		candidateIntervalIDs = append(candidateIntervalIDs, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read stale check rows: %w", err)
	}

	for _, intervalID := range candidateIntervalIDs {
		var count int
		checkErr := database.QueryRowContext(ctx, `
			SELECT COUNT(*)
			FROM estimation_results
			WHERE calculation_logic_version = ?
			  AND calculation_interval_ids_json LIKE ?
		`, domain.CalculationLogicVersion, "%\""+intervalID+"\"%").Scan(&count)
		if checkErr != nil {
			return fmt.Errorf("check existing estimation result for interval %s: %w", intervalID, checkErr)
		}
		if count > 0 {
			continue
		}
		if err := l.recalculateInterval(ctx, intervalID); err != nil {
			return err
		}
	}
	return nil
}
