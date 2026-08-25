package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

func scopeForMutation(ctx context.Context, tx *sql.Tx, mutation CatalogMutation, before, after any) (domain.RecalculationScope, error) {
	var scope domain.RecalculationScope
	switch mutation.EntityType {
	case "catalog_service":
		scope.ServiceIDs = append(scope.ServiceIDs, mutation.EntityID)
	case "catalog_service_identifier_mapping":
		var serviceID string
		if err := tx.QueryRowContext(ctx, `SELECT service_id FROM service_identifier_mappings WHERE mapping_id = ?`, mutation.EntityID).Scan(&serviceID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	case "catalog_limit_definition":
		var serviceID string
		if err := tx.QueryRowContext(ctx, `SELECT service_id FROM limit_definitions WHERE limit_definition_id = ?`, mutation.EntityID).Scan(&serviceID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.DefinitionIDs = append(scope.DefinitionIDs, mutation.EntityID)
		scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	case "catalog_plan":
		if err := appendPlanScope(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_plan_version":
		if err := appendPlanVersionScope(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_plan_limit_rule":
		var definitionID, serviceID string
		if err := tx.QueryRowContext(ctx, `SELECT r.limit_definition_id, p.service_id FROM plan_limit_rules r JOIN plan_versions pv ON pv.plan_version_id = r.plan_version_id JOIN plans p ON p.plan_id = pv.plan_id WHERE r.plan_limit_rule_id = ?`, mutation.EntityID).Scan(&definitionID, &serviceID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.DefinitionIDs = append(scope.DefinitionIDs, definitionID)
		scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	case "catalog_standard_price":
		if err := appendPlanVersionScopeByPrice(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_identification_candidate":
		if err := appendIdentificationCandidateValue(ctx, tx, &scope, before); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		if err := appendIdentificationCandidateValue(ctx, tx, &scope, after); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		var serviceID, planID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT service_id, plan_id FROM identification_candidates WHERE candidate_id = ?`, mutation.EntityID).Scan(&serviceID, &planID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		if serviceID.Valid {
			scope.ServiceIDs = append(scope.ServiceIDs, serviceID.String)
		}
		if planID.Valid {
			if err := appendPlanScope(ctx, tx, &scope, planID.String); err != nil {
				return scope, scopeMutationError(mutation, err)
			}
		}
	case "catalog_logical_account":
		if err := appendAccountScope(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_hub_account_candidate":
		var serviceID string
		var accountID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT service_id, logical_account_id FROM hub_account_candidates WHERE hub_account_candidate_id = ?`, mutation.EntityID).Scan(&serviceID, &accountID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
		if accountID.Valid {
			scope.AccountIDs = append(scope.AccountIDs, accountID.String)
		}
	case "catalog_plan_history":
		var accountID, planVersionID string
		if err := tx.QueryRowContext(ctx, `SELECT logical_account_id, plan_version_id FROM plan_histories WHERE plan_history_id = ?`, mutation.EntityID).Scan(&accountID, &planVersionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.AccountIDs = append(scope.AccountIDs, accountID)
		if err := appendPlanVersionScope(ctx, tx, &scope, planVersionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_usage_cost_source":
		scope.CostSourceIDs = append(scope.CostSourceIDs, mutation.EntityID)
		if err := appendCostSourceAccounts(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_usage_limit_source":
		scope.LimitSourceIDs = append(scope.LimitSourceIDs, mutation.EntityID)
		if err := appendLimitSourceLinks(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_usage_cost_association":
		var sourceID, accountID string
		if err := tx.QueryRowContext(ctx, `SELECT usage_cost_source_id, logical_account_id FROM usage_cost_source_account_links WHERE usage_cost_association_id = ?`, mutation.EntityID).Scan(&sourceID, &accountID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.CostSourceIDs = append(scope.CostSourceIDs, sourceID)
		if err := appendAccountScope(ctx, tx, &scope, accountID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_usage_limit_association":
		var sourceID, accountID, definitionID string
		if err := tx.QueryRowContext(ctx, `SELECT usage_limit_source_id, logical_account_id, limit_definition_id FROM usage_limit_source_links WHERE usage_limit_association_id = ?`, mutation.EntityID).Scan(&sourceID, &accountID, &definitionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.LimitSourceIDs = append(scope.LimitSourceIDs, sourceID)
		scope.AccountIDs = append(scope.AccountIDs, accountID)
		scope.DefinitionIDs = append(scope.DefinitionIDs, definitionID)
		if err := appendDefinitionService(ctx, tx, &scope, definitionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	case "catalog_usage_cost_source_completeness":
		var sourceID, accountsJSON string
		if err := tx.QueryRowContext(ctx, `SELECT usage_cost_source_id, logical_account_ids_json FROM usage_cost_source_completeness WHERE completeness_id = ?`, mutation.EntityID).Scan(&sourceID, &accountsJSON); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.CostSourceIDs = append(scope.CostSourceIDs, sourceID)
		var accountIDs []string
		if err := json.Unmarshal([]byte(accountsJSON), &accountIDs); err != nil {
			return scope, fmt.Errorf("decode completeness scope accounts: %w", err)
		}
		for _, accountID := range accountIDs {
			if err := appendAccountScope(ctx, tx, &scope, accountID); err != nil {
				return scope, scopeMutationError(mutation, err)
			}
		}
	case "catalog_calculation_interval":
		var serviceID, accountID, sourceID, definitionID string
		if err := tx.QueryRowContext(ctx, `SELECT service_id, logical_account_id, usage_limit_source_id, limit_definition_id FROM calculation_intervals WHERE calculation_interval_id = ?`, mutation.EntityID).Scan(&serviceID, &accountID, &sourceID, &definitionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
		scope.AccountIDs = append(scope.AccountIDs, accountID)
		scope.LimitSourceIDs = append(scope.LimitSourceIDs, sourceID)
		scope.DefinitionIDs = append(scope.DefinitionIDs, definitionID)
		scope.IntervalIDs = append(scope.IntervalIDs, mutation.EntityID)
	case "catalog_limit_label_change_candidate":
		if err := appendLabelChangeCandidateValue(ctx, tx, &scope, before); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		if err := appendLabelChangeCandidateValue(ctx, tx, &scope, after); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		var definitionID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT limit_definition_id FROM limit_label_change_candidates WHERE candidate_id = ?`, mutation.EntityID).Scan(&definitionID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
		if definitionID.Valid {
			scope.DefinitionIDs = append(scope.DefinitionIDs, definitionID.String)
			if err := appendDefinitionService(ctx, tx, &scope, definitionID.String); err != nil {
				return scope, scopeMutationError(mutation, err)
			}
		}
	case "catalog_hub_switch":
		if err := appendHubSwitchSources(ctx, tx, &scope, mutation.EntityID); err != nil {
			return scope, scopeMutationError(mutation, err)
		}
	default:
		return scope, fmt.Errorf("recalculation scope is not defined for entity type %q", mutation.EntityType)
	}
	return scope, nil
}

func scopeMutationError(mutation CatalogMutation, err error) error {
	if err == sql.ErrNoRows {
		return fmt.Errorf("resolve recalculation scope for %s %q: entity was not found", mutation.EntityType, mutation.EntityID)
	}
	return fmt.Errorf("resolve recalculation scope for %s %q: %w", mutation.EntityType, mutation.EntityID, err)
}

func appendAccountScope(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, accountID string) error {
	scope.AccountIDs = append(scope.AccountIDs, accountID)
	var serviceID string
	if err := tx.QueryRowContext(ctx, `SELECT service_id FROM logical_accounts WHERE logical_account_id = ?`, accountID).Scan(&serviceID); err != nil {
		return err
	}
	scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	return nil
}

func appendDefinitionService(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, definitionID string) error {
	var serviceID string
	if err := tx.QueryRowContext(ctx, `SELECT service_id FROM limit_definitions WHERE limit_definition_id = ?`, definitionID).Scan(&serviceID); err != nil {
		return err
	}
	scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	return nil
}

func appendIdentificationCandidateValue(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, value any) error {
	var candidate domain.IdentificationCandidate
	switch typed := value.(type) {
	case domain.IdentificationCandidate:
		candidate = typed
	case *domain.IdentificationCandidate:
		if typed == nil {
			return nil
		}
		candidate = *typed
	default:
		return nil
	}
	if candidate.ServiceID != nil {
		scope.ServiceIDs = append(scope.ServiceIDs, *candidate.ServiceID)
	}
	if candidate.PlanID != nil {
		if err := appendPlanScope(ctx, tx, scope, *candidate.PlanID); err != nil {
			return err
		}
	}
	return nil
}

func appendLabelChangeCandidateValue(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, value any) error {
	var candidate domain.LimitLabelChangeCandidate
	switch typed := value.(type) {
	case domain.LimitLabelChangeCandidate:
		candidate = typed
	case *domain.LimitLabelChangeCandidate:
		if typed == nil {
			return nil
		}
		candidate = *typed
	default:
		return nil
	}
	if candidate.LimitDefinitionID != nil {
		scope.DefinitionIDs = append(scope.DefinitionIDs, *candidate.LimitDefinitionID)
		if err := appendDefinitionService(ctx, tx, scope, *candidate.LimitDefinitionID); err != nil {
			return err
		}
	}
	return nil
}

func appendPlanScope(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, planID string) error {
	var serviceID string
	if err := tx.QueryRowContext(ctx, `SELECT service_id FROM plans WHERE plan_id = ?`, planID).Scan(&serviceID); err != nil {
		return err
	}
	scope.ServiceIDs = append(scope.ServiceIDs, serviceID)
	return nil
}

func appendPlanVersionScope(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, planVersionID string) error {
	var planID string
	if err := tx.QueryRowContext(ctx, `SELECT plan_id FROM plan_versions WHERE plan_version_id = ?`, planVersionID).Scan(&planID); err != nil {
		return err
	}
	return appendPlanScope(ctx, tx, scope, planID)
}

func appendPlanVersionScopeByPrice(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, priceID string) error {
	var planVersionID string
	if err := tx.QueryRowContext(ctx, `SELECT plan_version_id FROM standard_prices WHERE standard_price_id = ?`, priceID).Scan(&planVersionID); err != nil {
		return err
	}
	return appendPlanVersionScope(ctx, tx, scope, planVersionID)
}

func appendCostSourceAccounts(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, sourceID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT logical_account_id FROM usage_cost_source_account_links WHERE usage_cost_source_id = ? ORDER BY logical_account_id`, sourceID)
	if err != nil {
		return err
	}
	var accountIDs []string
	for rows.Next() {
		var accountID string
		if err := rows.Scan(&accountID); err != nil {
			_ = rows.Close()
			return err
		}
		accountIDs = append(accountIDs, accountID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, accountID := range accountIDs {
		scope.AccountIDs = append(scope.AccountIDs, accountID)
		if err := appendAccountScope(ctx, tx, scope, accountID); err != nil {
			return err
		}
	}
	return nil
}

func appendLimitSourceLinks(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, sourceID string) error {
	rows, err := tx.QueryContext(ctx, `SELECT logical_account_id, limit_definition_id FROM usage_limit_source_links WHERE usage_limit_source_id = ? ORDER BY logical_account_id, limit_definition_id`, sourceID)
	if err != nil {
		return err
	}
	type sourceLink struct{ accountID, definitionID string }
	var links []sourceLink
	for rows.Next() {
		var accountID, definitionID string
		if err := rows.Scan(&accountID, &definitionID); err != nil {
			_ = rows.Close()
			return err
		}
		links = append(links, sourceLink{accountID: accountID, definitionID: definitionID})
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, link := range links {
		scope.AccountIDs = append(scope.AccountIDs, link.accountID)
		scope.DefinitionIDs = append(scope.DefinitionIDs, link.definitionID)
		if err := appendAccountScope(ctx, tx, scope, link.accountID); err != nil {
			return err
		}
		if err := appendDefinitionService(ctx, tx, scope, link.definitionID); err != nil {
			return err
		}
	}
	return nil
}

func appendHubSwitchSources(ctx context.Context, tx *sql.Tx, scope *domain.RecalculationScope, switchID string) error {
	var oldHub, oldDevice, newHub, newDevice string
	if err := tx.QueryRowContext(ctx, `SELECT old_hub_id, old_device_id, new_hub_id, new_device_id FROM hub_switches WHERE hub_switch_id = ?`, switchID).Scan(&oldHub, &oldDevice, &newHub, &newDevice); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT usage_cost_source_id FROM usage_cost_sources WHERE (hub_id = ? AND device_id = ?) OR (hub_id = ? AND device_id = ?) ORDER BY usage_cost_source_id`, oldHub, oldDevice, newHub, newDevice)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			return err
		}
		scope.CostSourceIDs = append(scope.CostSourceIDs, sourceID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = tx.QueryContext(ctx, `SELECT usage_limit_source_id FROM usage_limit_sources WHERE (hub_id = ? AND device_id = ?) OR (hub_id = ? AND device_id = ?) ORDER BY usage_limit_source_id`, oldHub, oldDevice, newHub, newDevice)
	if err != nil {
		return err
	}
	for rows.Next() {
		var sourceID string
		if err := rows.Scan(&sourceID); err != nil {
			_ = rows.Close()
			return err
		}
		scope.LimitSourceIDs = append(scope.LimitSourceIDs, sourceID)
	}
	return rows.Close()
}
