package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

func (l *Lifecycle) ListServices(ctx context.Context, includeArchived bool) (result []Service, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT service_id, provider, name, official_key, archived_at, created_at, updated_at FROM services`
	if !includeArchived {
		query += ` WHERE archived_at IS NULL`
	}
	query += ` ORDER BY provider, name, service_id`
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close services rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var service Service
		var archived, created, updated sql.NullString
		if err := rows.Scan(&service.ID, &service.Provider, &service.Name, &service.OfficialKey, &archived, &created, &updated); err != nil {
			return nil, fmt.Errorf("scan service: %w", err)
		}
		if archived.Valid {
			value, err := parseUTC(archived.String)
			if err != nil {
				return nil, fmt.Errorf("parse service archive time: %w", err)
			}
			service.ArchivedAt = &value
		}
		var err error
		service.CreatedAt, err = parseUTC(created.String)
		if err != nil {
			return nil, fmt.Errorf("parse service creation time: %w", err)
		}
		service.UpdatedAt, err = parseUTC(updated.String)
		if err != nil {
			return nil, fmt.Errorf("parse service update time: %w", err)
		}
		result = append(result, service)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read services: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListServiceIdentifierMappings(ctx context.Context, kind domain.ServiceIdentifierKind, rawIdentifier string) (result []ServiceIdentifierMapping, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT mapping_id, identifier_kind, raw_identifier, service_id, valid_from, valid_to, created_at FROM service_identifier_mappings`
	args := []any{}
	if kind != "" {
		query += ` WHERE identifier_kind = ?`
		args = append(args, kind)
	}
	if rawIdentifier != "" {
		if len(args) == 0 {
			query += ` WHERE raw_identifier = ?`
		} else {
			query += ` AND raw_identifier = ?`
		}
		args = append(args, rawIdentifier)
	}
	query += ` ORDER BY raw_identifier, valid_from, mapping_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list service identifier mappings: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close service identifier mapping rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var mapping ServiceIdentifierMapping
		var kindText string
		var from, created string
		var to sql.NullString
		if err := rows.Scan(&mapping.ID, &kindText, &mapping.RawIdentifier, &mapping.ServiceID, &from, &to, &created); err != nil {
			return nil, fmt.Errorf("scan service identifier mapping: %w", err)
		}
		mapping.Kind = domain.ServiceIdentifierKind(kindText)
		mapping.ValidFrom, err = parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse mapping start: %w", err)
		}
		if to.Valid {
			value, err := parseUTC(to.String)
			if err != nil {
				return nil, fmt.Errorf("parse mapping end: %w", err)
			}
			mapping.ValidTo = &value
		}
		mapping.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse mapping creation time: %w", err)
		}
		result = append(result, mapping)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read service identifier mappings: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListLimitDefinitions(ctx context.Context, includeArchived bool) (result []LimitDefinition, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, archived_at, created_at, updated_at FROM limit_definitions`
	if !includeArchived {
		query += ` WHERE archived_at IS NULL`
	}
	query += ` ORDER BY service_id, cycle_type, meaning, limit_definition_id`
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("list limit definitions: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close limit definition rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var definition LimitDefinition
		var confirmation, created, updated string
		var archived sql.NullString
		if err := rows.Scan(&definition.ID, &definition.ServiceID, &definition.CycleType, &definition.Meaning, &definition.Unit, &confirmation, &archived, &created, &updated); err != nil {
			return nil, fmt.Errorf("scan limit definition: %w", err)
		}
		definition.BillingConfirmation = domain.BillingConfirmation(confirmation)
		if archived.Valid {
			value, err := parseUTC(archived.String)
			if err != nil {
				return nil, fmt.Errorf("parse limit definition archive time: %w", err)
			}
			definition.ArchivedAt = &value
		}
		var err error
		definition.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse limit definition creation time: %w", err)
		}
		definition.UpdatedAt, err = parseUTC(updated)
		if err != nil {
			return nil, fmt.Errorf("parse limit definition update time: %w", err)
		}
		result = append(result, definition)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read limit definitions: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListPlans(ctx context.Context, serviceID string, includeArchived bool) (result []Plan, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT plan_id, service_id, name, is_baseline, archived_at, created_at, updated_at FROM plans WHERE 1 = 1`
	args := []any{}
	if serviceID != "" {
		query += ` AND service_id = ?`
		args = append(args, serviceID)
	}
	if !includeArchived {
		query += ` AND archived_at IS NULL`
	}
	query += ` ORDER BY service_id, name, plan_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list plans: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close plan rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var plan Plan
		var baseline int
		var archived, created, updated sql.NullString
		if err := rows.Scan(&plan.ID, &plan.ServiceID, &plan.Name, &baseline, &archived, &created, &updated); err != nil {
			return nil, fmt.Errorf("scan plan: %w", err)
		}
		plan.IsBaseline = baseline != 0
		if archived.Valid {
			value, err := parseUTC(archived.String)
			if err != nil {
				return nil, fmt.Errorf("parse plan archive time: %w", err)
			}
			plan.ArchivedAt = &value
		}
		var err error
		plan.CreatedAt, err = parseUTC(created.String)
		if err != nil {
			return nil, fmt.Errorf("parse plan creation time: %w", err)
		}
		plan.UpdatedAt, err = parseUTC(updated.String)
		if err != nil {
			return nil, fmt.Errorf("parse plan update time: %w", err)
		}
		result = append(result, plan)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read plans: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListPlanVersions(ctx context.Context, planID string) (result []PlanVersion, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT plan_version_id, plan_id, name, valid_from, valid_to, official_source_url, created_at FROM plan_versions`
	args := []any{}
	if planID != "" {
		query += ` WHERE plan_id = ?`
		args = append(args, planID)
	}
	query += ` ORDER BY plan_id, valid_from, plan_version_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list plan versions: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close plan version rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var version PlanVersion
		var from, created string
		var to sql.NullString
		if err := rows.Scan(&version.ID, &version.PlanID, &version.Name, &from, &to, &version.OfficialSourceURL, &created); err != nil {
			return nil, fmt.Errorf("scan plan version: %w", err)
		}
		version.ValidFrom, err = parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse plan version start: %w", err)
		}
		if to.Valid {
			value, err := parseUTC(to.String)
			if err != nil {
				return nil, fmt.Errorf("parse plan version end: %w", err)
			}
			version.ValidTo = &value
		}
		version.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse plan version creation time: %w", err)
		}
		result = append(result, version)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read plan versions: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListPlanLimitRules(ctx context.Context, planVersionID string) (result []PlanLimitRule, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT plan_limit_rule_id, plan_version_id, limit_definition_id, plan_limit, limit_multiplier, official_source_url, created_at FROM plan_limit_rules`
	args := []any{}
	if planVersionID != "" {
		query += ` WHERE plan_version_id = ?`
		args = append(args, planVersionID)
	}
	query += ` ORDER BY plan_version_id, limit_definition_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list plan limit rules: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close plan limit rule rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var rule PlanLimitRule
		var limit, multiplier sql.NullFloat64
		var created string
		if err := rows.Scan(&rule.ID, &rule.PlanVersionID, &rule.LimitDefinitionID, &limit, &multiplier, &rule.OfficialSourceURL, &created); err != nil {
			return nil, fmt.Errorf("scan plan limit rule: %w", err)
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
			return nil, fmt.Errorf("parse plan limit rule creation time: %w", err)
		}
		result = append(result, rule)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read plan limit rules: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListStandardPrices(ctx context.Context, planVersionID string) (result []StandardPrice, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT standard_price_id, plan_version_id, usd_monthly_per_seat, source_url, valid_from, valid_to, created_at FROM standard_prices`
	args := []any{}
	if planVersionID != "" {
		query += ` WHERE plan_version_id = ?`
		args = append(args, planVersionID)
	}
	query += ` ORDER BY plan_version_id, valid_from, standard_price_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list standard prices: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close standard price rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var price StandardPrice
		var from, created string
		var to sql.NullString
		if err := rows.Scan(&price.ID, &price.PlanVersionID, &price.USDMonthlyPerSeat, &price.SourceURL, &from, &to, &created); err != nil {
			return nil, fmt.Errorf("scan standard price: %w", err)
		}
		price.ValidFrom, err = parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse standard price start: %w", err)
		}
		if to.Valid {
			value, err := parseUTC(to.String)
			if err != nil {
				return nil, fmt.Errorf("parse standard price end: %w", err)
			}
			price.ValidTo = &value
		}
		price.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse standard price creation time: %w", err)
		}
		result = append(result, price)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read standard prices: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListIdentificationCandidates(ctx context.Context, state domain.CandidateState) (result []IdentificationCandidate, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates`
	args := []any{}
	if state != "" {
		query += ` WHERE state = ?`
		args = append(args, state)
	}
	query += ` ORDER BY state, raw_limit_service_identifier, raw_reported_plan_name, candidate_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list identification candidates: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close identification candidate rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var candidate IdentificationCandidate
		if err := scanCandidate(rows, &candidate); err != nil {
			return nil, err
		}
		result = append(result, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read identification candidates: %w", err)
	}
	return result, nil
}

type IdentificationCandidateObservation = domain.IdentificationCandidateObservation

func (l *Lifecycle) ListIdentificationCandidateObservations(ctx context.Context, candidateID string) (result []IdentificationCandidateObservation, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT observation_id, candidate_id, hub_id, hub_account_display, observed_at FROM identification_candidate_observations WHERE candidate_id = ? ORDER BY observed_at, observation_id`, candidateID)
	if err != nil {
		return nil, fmt.Errorf("list candidate observations: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close identification candidate observation rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var item IdentificationCandidateObservation
		var observed string
		if err := rows.Scan(&item.ID, &item.CandidateID, &item.HubID, &item.HubAccountDisplay, &observed); err != nil {
			return nil, fmt.Errorf("scan candidate observation: %w", err)
		}
		item.ObservedAt, err = parseUTC(observed)
		if err != nil {
			return nil, fmt.Errorf("parse candidate observation time: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read candidate observations: %w", err)
	}
	return result, nil
}
