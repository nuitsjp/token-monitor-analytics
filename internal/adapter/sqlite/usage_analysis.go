package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"token-monitor-analytics/internal/domain"
)

type UsageAnalysisObservation = domain.UsageObservation

type UsageNativeAmount = domain.UsageNativeAmount

func (l *Lifecycle) ListUsageAnalysisObservations(ctx context.Context) ([]UsageAnalysisObservation, error) {
	accounts, err := l.ListLogicalAccounts(ctx, "", true)
	if err != nil {
		return nil, err
	}
	accountNames := make(map[string]string, len(accounts))
	for _, account := range accounts {
		accountNames[account.ID] = account.DisplayName
	}
	associations, err := l.ListUsageCostAssociations(ctx, "")
	if err != nil {
		return nil, err
	}
	completeness, err := l.ListUsageCostSourceCompleteness(ctx, "")
	if err != nil {
		return nil, err
	}
	limitSources, err := l.ListUsageLimitSources(ctx, "")
	if err != nil {
		return nil, err
	}
	limitAssociations, err := l.ListUsageLimitAssociations(ctx, "")
	if err != nil {
		return nil, err
	}
	histories, err := l.ListPlanHistories(ctx, "")
	if err != nil {
		return nil, err
	}
	planVersions, err := l.ListPlanVersions(ctx, "")
	if err != nil {
		return nil, err
	}
	planVersionNames := make(map[string]string, len(planVersions))
	for _, version := range planVersions {
		planVersionNames[version.ID] = version.Name
	}
	rules, err := l.ListPlanLimitRules(ctx, "")
	if err != nil {
		return nil, err
	}
	switches, err := l.ListHubSwitches(ctx)
	if err != nil {
		return nil, err
	}

	limitSourceIDsByKey := make(map[string][]string, len(limitSources))
	for _, source := range limitSources {
		key := usageSourceKey(source.HubID, source.DeviceID, source.RawServiceIdentifier)
		limitSourceIDsByKey[key] = append(limitSourceIDsByKey[key], source.ID)
	}
	limitAssociationsBySource := make(map[string][]domain.UsageLimitAssociation, len(limitAssociations))
	for _, association := range limitAssociations {
		limitAssociationsBySource[association.UsageLimitSourceID] = append(limitAssociationsBySource[association.UsageLimitSourceID], association)
	}
	rulesByPlanVersion := make(map[string][]string, len(rules))
	for _, rule := range rules {
		rulesByPlanVersion[rule.PlanVersionID] = appendUniqueString(rulesByPlanVersion[rule.PlanVersionID], rule.LimitDefinitionID)
	}

	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT o.usage_observation_id, o.snapshot_id, src.usage_cost_source_id,
		       o.hub_id, h.display_name, o.device_id, o.raw_service_identifier,
		       COALESCE(m.service_id, ''), COALESCE(s.name, ''), o.usage_updated_at,
		       o.token_count, o.api_cost_usd_text, o.model_tokens_json, o.model_costs_json, o.json_path
		FROM usage_analysis_observations o
		LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
		JOIN hubs h ON h.hub_id = o.hub_id
		JOIN usage_cost_sources src
		  ON src.hub_id = o.hub_id AND src.device_id = o.device_id
		 AND src.raw_service_identifier = o.raw_service_identifier
		LEFT JOIN service_identifier_mappings m
		  ON m.identifier_kind = 'usage_cost' AND m.raw_identifier = o.raw_service_identifier
		 AND m.valid_from <= o.usage_updated_at AND (m.valid_to IS NULL OR o.usage_updated_at < m.valid_to)
		LEFT JOIN services s ON s.service_id = m.service_id
		WHERE o.dedupe_state = 'canonical' AND (nr.state = 'active' OR nr.state IS NULL)
		ORDER BY src.usage_cost_source_id, o.usage_updated_at, o.usage_observation_id`)
	if err != nil {
		return nil, fmt.Errorf("list usage analysis observations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]UsageAnalysisObservation, 0)
	for rows.Next() {
		var item UsageAnalysisObservation
		var observedAt, modelTokensJSON, modelCostsJSON string
		var cost sql.NullString
		if err := rows.Scan(&item.ID, &item.SnapshotID, &item.SourceID, &item.HubID, &item.HubName,
			&item.DeviceID, &item.RawServiceIdentifier, &item.ServiceID, &item.ServiceName, &observedAt,
			&item.TokenCount, &cost, &modelTokensJSON, &modelCostsJSON, &item.JSONPath); err != nil {
			return nil, fmt.Errorf("scan usage analysis observation: %w", err)
		}
		item.ObservedAt, err = parseUTC(observedAt)
		if err != nil {
			return nil, fmt.Errorf("parse usage observation time: %w", err)
		}
		if cost.Valid {
			item.APICostUSDText = cost.String
		}
		if err := json.Unmarshal([]byte(modelTokensJSON), &item.ModelTokens); err != nil {
			return nil, fmt.Errorf("decode model token observations: %w", err)
		}
		if err := json.Unmarshal([]byte(modelCostsJSON), &item.ModelCosts); err != nil {
			return nil, fmt.Errorf("decode model cost observations: %w", err)
		}
		item.CollectionDeviceID = collectionDeviceAt(switches, item.HubID, item.DeviceID, item.ObservedAt)
		for _, association := range associations {
			if association.UsageCostSourceID == item.SourceID && activeAt(association.ValidFrom, association.ValidTo, item.ObservedAt) {
				item.AccountIDs = append(item.AccountIDs, association.LogicalAccountID)
				item.AccountNames = append(item.AccountNames, accountNames[association.LogicalAccountID])
			}
		}
		sort.Strings(item.AccountIDs)
		sort.Strings(item.AccountNames)
		for _, assertion := range completeness {
			if assertion.UsageCostSourceID == item.SourceID && activeAt(assertion.ValidFrom, assertion.ValidTo, item.ObservedAt) {
				item.CompletenessConfirmed = assertion.State == domain.CompletenessConfirmed && len(assertion.ExcludedActivity) == 0 && sameStrings(assertion.LogicalAccountIDs, item.AccountIDs)
				break
			}
		}
		for _, accountID := range item.AccountIDs {
			for _, history := range histories {
				if history.LogicalAccountID != accountID || !activeAt(history.ValidFrom, history.ValidTo, item.ObservedAt) {
					continue
				}
				item.PlanVersionIDs = appendUniqueString(item.PlanVersionIDs, history.PlanVersionID)
				for _, definitionID := range rulesByPlanVersion[history.PlanVersionID] {
					item.LimitDefinitionIDs = appendUniqueString(item.LimitDefinitionIDs, definitionID)
				}
			}
		}
		for _, sourceID := range limitSourceIDsByKey[usageSourceKey(item.HubID, item.DeviceID, item.RawServiceIdentifier)] {
			for _, association := range limitAssociationsBySource[sourceID] {
				if !activeAt(association.ValidFrom, association.ValidTo, item.ObservedAt) {
					continue
				}
				item.LimitDefinitionIDs = appendUniqueString(item.LimitDefinitionIDs, association.LimitDefinitionID)
				for _, history := range histories {
					if history.LogicalAccountID == association.LogicalAccountID && activeAt(history.ValidFrom, history.ValidTo, item.ObservedAt) {
						item.PlanVersionIDs = appendUniqueString(item.PlanVersionIDs, history.PlanVersionID)
						for _, definitionID := range rulesByPlanVersion[history.PlanVersionID] {
							item.LimitDefinitionIDs = appendUniqueString(item.LimitDefinitionIDs, definitionID)
						}
					}
				}
			}
		}
		sort.Strings(item.PlanVersionIDs)
		for _, planVersionID := range item.PlanVersionIDs {
			name := planVersionNames[planVersionID]
			if name == "" {
				name = planVersionID
			}
			item.PlanVersionNames = append(item.PlanVersionNames, name)
		}
		sort.Strings(item.LimitDefinitionIDs)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage analysis observations: %w", err)
	}
	return result, nil
}

func usageSourceKey(hubID, deviceID, rawServiceIdentifier string) string {
	return hubID + "\x00" + deviceID + "\x00" + rawServiceIdentifier
}

func appendUniqueString(values []string, value string) []string {
	if value == "" {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func collectionDeviceAt(switches []domain.HubSwitch, hubID, deviceID string, at time.Time) string {
	var before *domain.HubSwitch
	var after *domain.HubSwitch
	for index := range switches {
		switchRecord := &switches[index]
		if switchRecord.CollectionDeviceID == "" {
			continue
		}
		if switchRecord.NewHubID == hubID && switchRecord.NewDeviceID == deviceID && !at.Before(switchRecord.SwitchedAt) {
			if before == nil || switchRecord.SwitchedAt.After(before.SwitchedAt) {
				before = switchRecord
			}
		}
		if switchRecord.OldHubID == hubID && switchRecord.OldDeviceID == deviceID && at.Before(switchRecord.SwitchedAt) {
			if after == nil || switchRecord.SwitchedAt.Before(after.SwitchedAt) {
				after = switchRecord
			}
		}
	}
	if before != nil {
		return before.CollectionDeviceID
	}
	if after != nil {
		return after.CollectionDeviceID
	}
	return ""
}

func (l *Lifecycle) ListUsageNativeAmounts(ctx context.Context) ([]UsageNativeAmount, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT o.observation_id, o.snapshot_id, o.hub_id, h.display_name, o.device_id,
		       o.raw_service_identifier, o.window_key, o.normalized_label, o.normalized_metric,
		       o.provider_updated_at, a.used_text, a.limit_text, a.remaining_text, a.currency, o.json_path
		FROM usage_limit_amount_observations a
		JOIN usage_limit_observations o ON o.observation_id = a.observation_id
		LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
		JOIN hubs h ON h.hub_id = o.hub_id
		WHERE o.dedupe_state = 'canonical' AND (nr.state = 'active' OR nr.state IS NULL)
		ORDER BY o.provider_updated_at DESC, o.observation_id`)
	if err != nil {
		return nil, fmt.Errorf("list native usage amounts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]UsageNativeAmount, 0)
	for rows.Next() {
		var item UsageNativeAmount
		var observedAt string
		var used, limit, remaining, currency sql.NullString
		if err := rows.Scan(&item.ObservationID, &item.SnapshotID, &item.HubID, &item.HubName, &item.DeviceID,
			&item.RawServiceIdentifier, &item.WindowKey, &item.Label, &item.Metric, &observedAt,
			&used, &limit, &remaining, &currency, &item.JSONPath); err != nil {
			return nil, fmt.Errorf("scan native usage amount: %w", err)
		}
		item.ObservedAt, err = parseUTC(observedAt)
		if err != nil {
			return nil, err
		}
		item.UsedText, item.LimitText, item.RemainingText, item.Currency = used.String, limit.String, remaining.String, currency.String
		result = append(result, item)
	}
	return result, rows.Err()
}

func activeAt(start time.Time, end *time.Time, at time.Time) bool {
	return !at.Before(start) && (end == nil || at.Before(*end))
}

func sameStrings(left, right []string) bool {
	a, b := append([]string(nil), left...), append([]string(nil), right...)
	sort.Strings(a)
	sort.Strings(b)
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
