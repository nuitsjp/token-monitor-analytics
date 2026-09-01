package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"token-monitor-analytics/internal/domain"
)

type CalculationBoundary = domain.CalculationBoundary
type CalculationInterval = domain.CalculationInterval
type CalculationBuildRequest = domain.CalculationBuildRequest
type CalculationSeries = domain.CalculationSeries
type CalculationObservation = domain.CalculationObservation
type CalculationCostObservation = domain.CalculationCostObservation
type CalculationCostSource = domain.CalculationCostSource
type CalculationPeriod = domain.CalculationPeriod
type CalculationCompleteness = domain.CalculationCompleteness

var (
	ErrCalculationIntervalNotFound = errors.New("calculation interval was not found")
)

// ListCalculationSeries reads only the confirmed catalog and observation
// relations that are needed to derive half-open calculation intervals.
func (l *Lifecycle) ListCalculationSeries(ctx context.Context, request CalculationBuildRequest) ([]CalculationSeries, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT ul.usage_limit_source_id, ul.logical_account_id, ul.limit_definition_id,
		       us.hub_id, us.device_id, us.account_key, us.raw_service_identifier,
		       us.window_key, la.service_id, ld.cycle_type, ld.billing_confirmation,
		       ul.valid_from, ul.valid_to
		FROM usage_limit_source_links ul
		JOIN usage_limit_sources us ON us.usage_limit_source_id = ul.usage_limit_source_id
		JOIN logical_accounts la ON la.logical_account_id = ul.logical_account_id
		JOIN limit_definitions ld ON ld.limit_definition_id = ul.limit_definition_id
		WHERE la.service_id = ?
		  AND (ul.valid_to IS NULL OR ul.valid_to > ?)
		  AND ul.valid_from < ?
		ORDER BY ul.usage_limit_source_id, ul.valid_from, ul.usage_limit_association_id`,
		request.ServiceID, catalogPeriodText(request.ValidFrom), catalogPeriodText(request.ValidTo))
	if err != nil {
		return nil, fmt.Errorf("list calculation source relations: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation source relation rows: %w", closeErr)
		}
	}()
	type calculationSeriesSeed struct {
		series                      CalculationSeries
		sourceHubID, sourceDeviceID string
		accountKey, rawIdentifier   string
		windowKey                   string
	}
	var seeds []calculationSeriesSeed
	for rows.Next() {
		var seed calculationSeriesSeed
		var associationFrom, cycle, billing string
		var associationEnd sql.NullString
		if err := rows.Scan(&seed.series.UsageLimitSourceID, &seed.series.LogicalAccountID, &seed.series.LimitDefinitionID,
			&seed.sourceHubID, &seed.sourceDeviceID, &seed.accountKey, &seed.rawIdentifier, &seed.windowKey, &seed.series.ServiceID,
			&cycle, &billing, &associationFrom, &associationEnd); err != nil {
			return nil, fmt.Errorf("scan calculation source relation: %w", err)
		}
		seed.series.CycleType = cycle
		seed.series.BillingConfirmation = domain.BillingConfirmation(billing)
		seed.series.Association.ValidFrom, err = parseUTC(associationFrom)
		if err != nil {
			return nil, fmt.Errorf("parse calculation association start: %w", err)
		}
		if associationEnd.Valid {
			value, parseErr := parseUTC(associationEnd.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse calculation association end: %w", parseErr)
			}
			seed.series.Association.ValidTo = &value
		}
		seeds = append(seeds, seed)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read calculation source relations: %w", err)
	}
	var result []CalculationSeries
	for _, seed := range seeds {
		series := seed.series
		if err := loadCalculationSeriesData(ctx, database, &series, seed.sourceHubID, seed.sourceDeviceID, seed.accountKey, seed.rawIdentifier, seed.windowKey, request); err != nil {
			return nil, err
		}
		result = append(result, series)
	}
	return result, nil
}

func loadCalculationSeriesData(ctx context.Context, database *sql.DB, series *CalculationSeries, hubID, deviceID, accountKey, rawIdentifier, windowKey string, request CalculationBuildRequest) (err error) {
	rows, err := database.QueryContext(ctx, `
		SELECT o.observation_id, o.provider_updated_at, o.resets_at, COALESCE(rs.api_contract, '')
		FROM usage_limit_observations o
		LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
		JOIN usage_limit_sources us ON us.hub_id = o.hub_id AND us.device_id = o.device_id
		 AND us.account_key = o.account_key AND us.raw_service_identifier = o.raw_service_identifier
		 AND us.window_key = o.window_key
		LEFT JOIN raw_snapshots rs ON rs.snapshot_id = o.snapshot_id
		WHERE us.usage_limit_source_id = ? AND o.dedupe_state = 'canonical'
		  AND (nr.state = 'active' OR nr.state IS NULL)
		  AND o.provider_updated_at >= ? AND o.provider_updated_at <= ?
		ORDER BY o.provider_updated_at, o.observation_id`,
		series.UsageLimitSourceID, utcText(request.ValidFrom), utcText(request.ValidTo))
	if err != nil {
		return fmt.Errorf("list calculation limit observations: %w", err)
	}
	limitRows := rows
	defer func() {
		if closeErr := limitRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation limit observation rows: %w", closeErr)
		}
	}()
	for limitRows.Next() {
		var observation CalculationObservation
		var observed, reset sql.NullString
		if err := limitRows.Scan(&observation.ID, &observed, &reset, &observation.APIContract); err != nil {
			return fmt.Errorf("scan calculation limit observation: %w", err)
		}
		observation.ObservedAt, err = parseUTC(observed.String)
		if err != nil {
			return fmt.Errorf("parse calculation limit observation time: %w", err)
		}
		if reset.Valid {
			value, parseErr := parseUTC(reset.String)
			if parseErr != nil {
				return fmt.Errorf("parse calculation reset time: %w", parseErr)
			}
			observation.ResetAt = &value
		}
		series.Observations = append(series.Observations, observation)
	}
	if err := limitRows.Err(); err != nil {
		return fmt.Errorf("read calculation limit observations: %w", err)
	}

	historyRows, err := database.QueryContext(ctx, `
		SELECT plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at
		FROM plan_histories WHERE logical_account_id = ?
		  AND (valid_to IS NULL OR valid_to > ?) AND valid_from < ?
		ORDER BY valid_from, plan_history_id`, series.LogicalAccountID, catalogPeriodText(request.ValidFrom), catalogPeriodText(request.ValidTo))
	if err != nil {
		return fmt.Errorf("list calculation plan histories: %w", err)
	}
	defer func() {
		if closeErr := historyRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation plan history rows: %w", closeErr)
		}
	}()
	for historyRows.Next() {
		var history PlanHistory
		if err := scanPlanHistory(historyRows, &history); err != nil {
			return err
		}
		series.PlanHistories = append(series.PlanHistories, history)
	}
	if err := historyRows.Err(); err != nil {
		return fmt.Errorf("read calculation plan histories: %w", err)
	}

	associationRows, err := database.QueryContext(ctx, `
		SELECT cs.usage_cost_source_id, ca.usage_cost_association_id, ca.valid_from, ca.valid_to
		FROM usage_cost_source_account_links ca
		JOIN usage_cost_sources cs ON cs.usage_cost_source_id = ca.usage_cost_source_id
		WHERE ca.logical_account_id = ?
		  AND (ca.valid_to IS NULL OR ca.valid_to > ?) AND ca.valid_from < ?
		ORDER BY cs.usage_cost_source_id, ca.valid_from, ca.usage_cost_association_id`,
		series.LogicalAccountID, catalogPeriodText(request.ValidFrom), catalogPeriodText(request.ValidTo))
	if err != nil {
		return fmt.Errorf("list calculation cost associations: %w", err)
	}
	defer func() {
		if closeErr := associationRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation cost association rows: %w", closeErr)
		}
	}()
	costSources := make(map[string]*CalculationCostSource)
	for associationRows.Next() {
		var sourceID, periodID, from string
		var to sql.NullString
		if err := associationRows.Scan(&sourceID, &periodID, &from, &to); err != nil {
			return fmt.Errorf("scan calculation cost association: %w", err)
		}
		start, parseErr := parseUTC(from)
		if parseErr != nil {
			return fmt.Errorf("parse calculation cost association start: %w", parseErr)
		}
		period := CalculationPeriod{ID: periodID, ValidFrom: start}
		if to.Valid {
			end, parseErr := parseUTC(to.String)
			if parseErr != nil {
				return fmt.Errorf("parse calculation cost association end: %w", parseErr)
			}
			period.ValidTo = &end
		}
		if costSources[sourceID] == nil {
			costSources[sourceID] = &CalculationCostSource{ID: sourceID}
		}
		costSources[sourceID].AssociationPeriods = append(costSources[sourceID].AssociationPeriods, period)
	}
	if err := associationRows.Err(); err != nil {
		return fmt.Errorf("read calculation cost associations: %w", err)
	}

	for sourceID, source := range costSources {
		completenessRows, err := database.QueryContext(ctx, `
			SELECT completeness_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json
			FROM usage_cost_source_completeness
			WHERE usage_cost_source_id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from < ?
			ORDER BY valid_from, completeness_id`, sourceID, catalogPeriodText(request.ValidFrom), catalogPeriodText(request.ValidTo))
		if err != nil {
			return fmt.Errorf("list calculation completeness: %w", err)
		}
		defer func() {
			if closeErr := completenessRows.Close(); closeErr != nil && err == nil {
				err = fmt.Errorf("close calculation completeness rows: %w", closeErr)
			}
		}()
		for completenessRows.Next() {
			var completeness CalculationCompleteness
			var from string
			var to sql.NullString
			var state, accountsJSON, excludedJSON string
			if err := completenessRows.Scan(&completeness.ID, &from, &to, &state, &accountsJSON, &excludedJSON); err != nil {
				return fmt.Errorf("scan calculation completeness: %w", err)
			}
			completeness.ValidFrom, err = parseUTC(from)
			if err != nil {
				return fmt.Errorf("parse calculation completeness start: %w", err)
			}
			if to.Valid {
				value, parseErr := parseUTC(to.String)
				if parseErr != nil {
					return fmt.Errorf("parse calculation completeness end: %w", parseErr)
				}
				completeness.ValidTo = &value
			}
			completeness.State = domain.CompletenessState(state)
			if err := json.Unmarshal([]byte(accountsJSON), &completeness.LogicalAccountIDs); err != nil {
				return fmt.Errorf("decode calculation completeness accounts: %w", err)
			}
			if err := json.Unmarshal([]byte(excludedJSON), &completeness.ExcludedActivity); err != nil {
				return fmt.Errorf("decode calculation completeness exclusions: %w", err)
			}
			source.Completeness = append(source.Completeness, completeness)
		}
		if err := completenessRows.Err(); err != nil {
			return fmt.Errorf("read calculation completeness: %w", err)
		}
		costObservationRows, err := database.QueryContext(ctx, `
			SELECT o.observation_id, o.usage_updated_at, o.cost_usd_text
			FROM usage_cost_observations o
			LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
			JOIN usage_cost_sources cs ON cs.hub_id = o.hub_id AND cs.device_id = o.device_id
			 AND cs.raw_service_identifier = o.raw_service_identifier
			JOIN service_identifier_mappings m ON m.identifier_kind = 'usage_cost'
			 AND m.raw_identifier = o.raw_service_identifier AND m.service_id = ?
			 AND m.valid_from <= o.usage_updated_at AND (m.valid_to IS NULL OR o.usage_updated_at < m.valid_to)
			WHERE cs.usage_cost_source_id = ? AND o.dedupe_state = 'canonical'
			  AND (nr.state = 'active' OR nr.state IS NULL)
			  AND o.usage_updated_at >= ? AND o.usage_updated_at <= ?
			ORDER BY o.usage_updated_at, o.observation_id`, series.ServiceID, sourceID, utcText(request.ValidFrom), utcText(request.ValidTo))
		if err != nil {
			return fmt.Errorf("list calculation cost observations: %w", err)
		}
		defer func() {
			if closeErr := costObservationRows.Close(); closeErr != nil && err == nil {
				err = fmt.Errorf("close calculation cost observation rows: %w", closeErr)
			}
		}()
		for costObservationRows.Next() {
			var observation CalculationCostObservation
			var observed string
			if err := costObservationRows.Scan(&observation.ID, &observed, &observation.ValueText); err != nil {
				return fmt.Errorf("scan calculation cost observation: %w", err)
			}
			observation.ObservedAt, err = parseUTC(observed)
			if err != nil {
				return fmt.Errorf("parse calculation cost observation time: %w", err)
			}
			source.Observations = append(source.Observations, observation)
		}
		if err := costObservationRows.Err(); err != nil {
			return fmt.Errorf("read calculation cost observations: %w", err)
		}
		series.CostSources = append(series.CostSources, *source)
	}
	sort.Slice(series.CostSources, func(a, b int) bool { return series.CostSources[a].ID < series.CostSources[b].ID })

	switchRows, err := database.QueryContext(ctx, `SELECT hub_switch_id, old_hub_id, old_device_id, new_hub_id, new_device_id, collection_device_id, switched_at, created_at FROM hub_switches WHERE switched_at >= ? AND switched_at <= ? ORDER BY switched_at, hub_switch_id`, utcText(request.ValidFrom), utcText(request.ValidTo))
	if err != nil {
		return fmt.Errorf("list calculation Hub switches: %w", err)
	}
	defer func() {
		if closeErr := switchRows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation Hub switch rows: %w", closeErr)
		}
	}()
	for switchRows.Next() {
		var switchRecord HubSwitch
		var switched, created string
		if err := switchRows.Scan(&switchRecord.ID, &switchRecord.OldHubID, &switchRecord.OldDeviceID, &switchRecord.NewHubID, &switchRecord.NewDeviceID, &switchRecord.CollectionDeviceID, &switched, &created); err != nil {
			return fmt.Errorf("scan calculation Hub switch: %w", err)
		}
		switchRecord.SwitchedAt, err = parseUTC(switched)
		if err != nil {
			return fmt.Errorf("parse calculation Hub switch time: %w", err)
		}
		switchRecord.CreatedAt, err = parseUTC(created)
		if err != nil {
			return fmt.Errorf("parse calculation Hub switch creation time: %w", err)
		}
		series.HubSwitches = append(series.HubSwitches, switchRecord)
	}
	if err := switchRows.Err(); err != nil {
		return fmt.Errorf("read calculation Hub switches: %w", err)
	}
	return nil
}

func (l *Lifecycle) SaveCalculationIntervals(ctx context.Context, intervals []CalculationInterval, boundaries []CalculationBoundary) error {
	if len(intervals) == 0 && len(boundaries) == 0 {
		return nil
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin calculation interval save: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	boundaryIDs := make(map[string]string, len(boundaries))
	for _, boundary := range boundaries {
		if err := boundary.Validate(); err != nil {
			return err
		}
		var existingID string
		err := tx.QueryRowContext(ctx, `SELECT calculation_boundary_id FROM calculation_boundaries WHERE usage_limit_source_id = ? AND boundary_at = ? AND boundary_kind = ? AND related_id = ?`, boundary.UsageLimitSourceID, catalogPeriodText(boundary.At), boundary.Kind, boundary.RelatedID).Scan(&existingID)
		if errors.Is(err, sql.ErrNoRows) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO calculation_boundaries (calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id, boundary_at, boundary_kind, reason, related_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, boundary.ID, boundary.ServiceID, boundary.LogicalAccountID, boundary.UsageLimitSourceID, catalogPeriodText(boundary.At), boundary.Kind, boundary.Reason, boundary.RelatedID, utcText(boundary.CreatedAt)); err != nil {
				return fmt.Errorf("insert calculation boundary: %w", err)
			}
			existingID = boundary.ID
		} else if err != nil {
			return fmt.Errorf("read calculation boundary: %w", err)
		}
		boundaryIDs[boundary.ID] = existingID
	}
	for _, interval := range intervals {
		if err := interval.Validate(); err != nil {
			return err
		}
		ids := make([]string, 0, len(interval.BoundaryIDs))
		for _, boundaryID := range interval.BoundaryIDs {
			storedID, ok := boundaryIDs[boundaryID]
			if !ok {
				var err error
				if err = tx.QueryRowContext(ctx, `SELECT calculation_boundary_id FROM calculation_boundaries WHERE calculation_boundary_id = ?`, boundaryID).Scan(&storedID); err != nil {
					return fmt.Errorf("calculation interval references unknown boundary: %w", err)
				}
			}
			ids = append(ids, storedID)
		}
		sort.Strings(ids)
		boundaryJSON, err := json.Marshal(ids)
		if err != nil {
			return fmt.Errorf("encode calculation interval boundaries: %w", err)
		}
		var existingID string
		err = tx.QueryRowContext(ctx, `SELECT calculation_interval_id FROM calculation_intervals WHERE usage_limit_source_id = ? AND logical_account_id = ? AND limit_definition_id = ? AND valid_from = ? AND valid_to = ?`, interval.UsageLimitSourceID, interval.LogicalAccountID, interval.LimitDefinitionID, catalogPeriodText(interval.ValidFrom), catalogPeriodText(interval.ValidTo)).Scan(&existingID)
		action := "create"
		if errors.Is(err, sql.ErrNoRows) {
			existingID = interval.ID
		} else if err != nil {
			return fmt.Errorf("read calculation interval: %w", err)
		} else {
			action = "update"
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO calculation_intervals
				(calculation_interval_id, service_id, logical_account_id, usage_limit_source_id,
				 limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state,
				 exclusion_reason, boundary_ids_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to)
			DO UPDATE SET service_id = excluded.service_id, plan_version_id = excluded.plan_version_id,
				cycle_type = excluded.cycle_type, state = excluded.state, exclusion_reason = excluded.exclusion_reason,
				boundary_ids_json = excluded.boundary_ids_json, updated_at = excluded.updated_at`,
			existingID, interval.ServiceID, interval.LogicalAccountID, interval.UsageLimitSourceID, interval.LimitDefinitionID,
			optionalIDString(interval.PlanVersionID), interval.CycleType, catalogPeriodText(interval.ValidFrom), catalogPeriodText(interval.ValidTo), interval.State,
			string(interval.ExclusionReason), string(boundaryJSON), utcText(interval.CreatedAt), utcText(interval.UpdatedAt)); err != nil {
			return fmt.Errorf("upsert calculation interval: %w", err)
		}
		mutation := catalogMutationForPeriod(action, "calculation_interval", existingID, interval.UpdatedAt, interval.ValidFrom, &interval.ValidTo)
		if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, interval); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit calculation interval save: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListCalculationIntervals(ctx context.Context, sourceID string) (result []CalculationInterval, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at FROM calculation_intervals`
	args := make([]any, 0, 1)
	if strings.TrimSpace(sourceID) != "" {
		query += ` WHERE usage_limit_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY usage_limit_source_id, valid_from, calculation_interval_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list calculation intervals: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation interval rows: %w", closeErr)
		}
	}()
	result = make([]CalculationInterval, 0)
	for rows.Next() {
		interval, err := scanCalculationInterval(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, interval)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read calculation intervals: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListCalculationBoundaries(ctx context.Context, sourceID string) (result []CalculationBoundary, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id, boundary_at, boundary_kind, reason, related_id, created_at FROM calculation_boundaries`
	args := make([]any, 0, 1)
	if strings.TrimSpace(sourceID) != "" {
		query += ` WHERE usage_limit_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY usage_limit_source_id, boundary_at, calculation_boundary_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list calculation boundaries: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close calculation boundary rows: %w", closeErr)
		}
	}()
	result = make([]CalculationBoundary, 0)
	for rows.Next() {
		var boundary CalculationBoundary
		var at, created string
		var kind string
		if err := rows.Scan(&boundary.ID, &boundary.ServiceID, &boundary.LogicalAccountID, &boundary.UsageLimitSourceID, &at, &kind, &boundary.Reason, &boundary.RelatedID, &created); err != nil {
			return nil, fmt.Errorf("scan calculation boundary: %w", err)
		}
		boundary.At, err = parseUTC(at)
		if err != nil {
			return nil, fmt.Errorf("parse calculation boundary time: %w", err)
		}
		boundary.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse calculation boundary creation time: %w", err)
		}
		boundary.Kind = domain.CalculationBoundaryKind(kind)
		result = append(result, boundary)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read calculation boundaries: %w", err)
	}
	return result, nil
}

func scanCalculationInterval(row rowScanner) (CalculationInterval, error) {
	var interval CalculationInterval
	var planID, from, to, state, exclusion, boundaryJSON, created, updated sql.NullString
	if err := row.Scan(&interval.ID, &interval.ServiceID, &interval.LogicalAccountID, &interval.UsageLimitSourceID, &interval.LimitDefinitionID, &planID, &interval.CycleType, &from, &to, &state, &exclusion, &boundaryJSON, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return CalculationInterval{}, fmt.Errorf("%w: %w", ErrCalculationIntervalNotFound, err)
		}
		return CalculationInterval{}, fmt.Errorf("scan calculation interval: %w", err)
	}
	interval.State = domain.CalculationIntervalState(state.String)
	interval.ExclusionReason = domain.CalculationExclusionReason(exclusion.String)
	if planID.Valid {
		interval.PlanVersionID = planID.String
	}
	var err error
	interval.ValidFrom, err = parseUTC(from.String)
	if err != nil {
		return CalculationInterval{}, fmt.Errorf("parse calculation interval start: %w", err)
	}
	interval.ValidTo, err = parseUTC(to.String)
	if err != nil {
		return CalculationInterval{}, fmt.Errorf("parse calculation interval end: %w", err)
	}
	if err := json.Unmarshal([]byte(boundaryJSON.String), &interval.BoundaryIDs); err != nil {
		return CalculationInterval{}, fmt.Errorf("decode calculation interval boundaries: %w", err)
	}
	interval.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return CalculationInterval{}, fmt.Errorf("parse calculation interval creation time: %w", err)
	}
	interval.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return CalculationInterval{}, fmt.Errorf("parse calculation interval update time: %w", err)
	}
	return interval, nil
}

func optionalIDString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
