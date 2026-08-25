package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

// ListCalculationMatchingInputs は推定可能な T-030 計算区間と、そこへ紐付く
// 不変観測および確認事実だけを読み込む。
func (l *Lifecycle) ListCalculationMatchingInputs(ctx context.Context, request domain.CalculationBuildRequest) ([]domain.CalculationMatchingInput, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT calculation_interval_id, service_id, logical_account_id, usage_limit_source_id,
		       limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to,
		       state, exclusion_reason, boundary_ids_json, created_at, updated_at
		FROM calculation_intervals
		WHERE service_id = ? AND valid_from >= ? AND valid_to <= ?
		ORDER BY valid_from, valid_to, limit_definition_id, plan_version_id, logical_account_id, calculation_interval_id`,
		request.ServiceID, catalogPeriodText(request.ValidFrom), catalogPeriodText(request.ValidTo))
	if err != nil {
		return nil, fmt.Errorf("list matching calculation intervals: %w", err)
	}
	type matchingGroup struct {
		key       string
		intervals []domain.CalculationInterval
		eligible  bool
	}
	groupsByKey := make(map[string]*matchingGroup)
	for rows.Next() {
		interval, scanErr := scanCalculationInterval(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		key := strings.Join([]string{interval.ServiceID, interval.LimitDefinitionID, interval.CycleType, catalogPeriodText(interval.ValidFrom), catalogPeriodText(interval.ValidTo)}, "|")
		group := groupsByKey[key]
		if group == nil {
			group = &matchingGroup{key: key, eligible: true}
			groupsByKey[key] = group
		}
		group.intervals = append(group.intervals, interval)
		if interval.State != domain.CalculationEstimable {
			group.eligible = false
		}
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matching calculation intervals: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read matching calculation intervals: %w", err)
	}
	groups := make([]*matchingGroup, 0, len(groupsByKey))
	for _, group := range groupsByKey {
		sort.Slice(group.intervals, func(a, b int) bool {
			return group.intervals[a].ID < group.intervals[b].ID
		})
		groups = append(groups, group)
	}
	sort.Slice(groups, func(a, b int) bool { return groups[a].key < groups[b].key })
	result := make([]domain.CalculationMatchingInput, 0, len(groups))
	for _, group := range groups {
		inputs, loadErr := l.loadCalculationMatchingInputs(ctx, database, group.intervals, group.eligible)
		if loadErr != nil {
			return nil, loadErr
		}
		result = append(result, inputs...)
	}
	return result, nil
}

func (l *Lifecycle) loadCalculationMatchingInputs(ctx context.Context, database *sql.DB, intervals []domain.CalculationInterval, eligible bool) ([]domain.CalculationMatchingInput, error) {
	if len(intervals) == 0 {
		return nil, nil
	}
	first := intervals[0]
	series := make([]domain.MatchingLimitSeries, 0, len(intervals))
	for _, interval := range intervals {
		if interval.State != domain.CalculationEstimable {
			continue
		}
		associationIDs, err := loadFullLimitAssociationIDs(ctx, database, interval.UsageLimitSourceID, interval.LogicalAccountID, interval.ValidFrom, interval.ValidTo)
		if err != nil {
			return nil, err
		}
		observations, err := loadMatchingLimitObservations(ctx, database, interval.UsageLimitSourceID, interval.ValidFrom, interval.ValidTo)
		if err != nil {
			return nil, err
		}
		series = append(series, domain.MatchingLimitSeries{
			CalculationIntervalID: interval.ID, LogicalAccountID: interval.LogicalAccountID,
			UsageLimitSourceID: interval.UsageLimitSourceID, PlanVersionID: interval.PlanVersionID,
			AssociationIDs: associationIDs, Observations: observations,
		})
	}
	if len(series) == 0 {
		return nil, nil
	}
	links, err := loadFullCostLinks(ctx, database, series, first.ValidFrom, first.ValidTo)
	if err != nil {
		return nil, err
	}
	components := matchingComponents(series, links)
	result := make([]domain.CalculationMatchingInput, 0, len(components))
	for _, component := range components {
		input := domain.CalculationMatchingInput{
			ServiceID: first.ServiceID, LimitDefinitionID: first.LimitDefinitionID,
			CycleType: first.CycleType, ValidFrom: first.ValidFrom, ValidTo: first.ValidTo, Eligible: eligible && component.MatchesTarget,
		}
		for _, item := range series {
			if _, ok := component.accounts[item.LogicalAccountID]; !ok {
				continue
			}
			input.CalculationIntervalIDs = append(input.CalculationIntervalIDs, item.CalculationIntervalID)
			input.LimitSeries = append(input.LimitSeries, item)
		}
		if len(input.LimitSeries) == 0 {
			continue
		}
		commonPlanVersionID := input.LimitSeries[0].PlanVersionID
		for _, item := range input.LimitSeries[1:] {
			if item.PlanVersionID != commonPlanVersionID {
				commonPlanVersionID = ""
				break
			}
		}
		input.PlanVersionID = commonPlanVersionID
		input.CalculationIntervalIDs = uniqueMatchingStrings(input.CalculationIntervalIDs)
		for _, link := range component.links {
			completenessIDs, complete, err := loadMatchingCompleteness(ctx, database, link.sourceID, link.accountIDs, input.ValidFrom, input.ValidTo)
			if err != nil {
				return nil, err
			}
			observations, err := loadMatchingCostObservations(ctx, database, link.sourceID, input.ValidFrom, input.ValidTo)
			if err != nil {
				return nil, err
			}
			input.CostSources = append(input.CostSources, domain.MatchingCostSource{
				UsageCostSourceID: link.sourceID, AssociationIDs: uniqueMatchingStrings(link.associationIDs),
				CompletenessIDs: completenessIDs, Complete: complete, Observations: observations,
			})
		}
		if len(input.CostSources) == 0 {
			continue
		}
		result = append(result, input)
	}
	return result, nil
}

func loadEstimationPlanVersionsByIDs(ctx context.Context, database *sql.DB, ids []string) ([]domain.EstimationPlanVersion, error) {
	result := make([]domain.EstimationPlanVersion, 0, len(ids))
	for _, id := range ids {
		var plan domain.EstimationPlanVersion
		var baseline int
		if err := database.QueryRowContext(ctx, `
			SELECT pv.plan_version_id, pv.plan_id, p.is_baseline
			FROM plan_versions pv JOIN plans p ON p.plan_id = pv.plan_id
			WHERE pv.plan_version_id = ?`, id).Scan(&plan.ID, &plan.PlanID, &baseline); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, fmt.Errorf("read estimation plan version: %w", err)
		}
		plan.IsBaseline = baseline != 0
		rows, err := database.QueryContext(ctx, `
			SELECT plan_limit_rule_id, plan_version_id, limit_definition_id, plan_limit,
			       limit_multiplier, official_source_url, created_at
			FROM plan_limit_rules WHERE plan_version_id = ? ORDER BY limit_definition_id, plan_limit_rule_id`, id)
		if err != nil {
			return nil, fmt.Errorf("list estimation plan rules: %w", err)
		}
		for rows.Next() {
			var rule domain.PlanLimitRule
			var limit, multiplier sql.NullFloat64
			var created string
			if err := rows.Scan(&rule.ID, &rule.PlanVersionID, &rule.LimitDefinitionID, &limit, &multiplier, &rule.OfficialSourceURL, &created); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan estimation plan rule: %w", err)
			}
			if limit.Valid {
				value := limit.Float64
				rule.Limit = &value
			}
			if multiplier.Valid {
				value := multiplier.Float64
				rule.Multiplier = &value
			}
			var parseErr error
			rule.CreatedAt, parseErr = parseUTC(created)
			if parseErr != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("parse estimation plan rule creation: %w", parseErr)
			}
			plan.LimitRules = append(plan.LimitRules, rule)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close estimation plan rules: %w", err)
		}
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("read estimation plan rules: %w", err)
		}
		result = append(result, plan)
	}
	return result, nil
}

type costLinkGroup struct {
	sourceID           string
	associationIDs     []string
	accountIDs         map[string]struct{}
	fullyCoveredTarget bool
}

type matchingComponent struct {
	accounts      map[string]struct{}
	links         []costLinkGroup
	MatchesTarget bool
}

func matchingComponents(series []domain.MatchingLimitSeries, links []costLinkGroup) []matchingComponent {
	targetAccounts := make(map[string]struct{}, len(series))
	for _, item := range series {
		targetAccounts[item.LogicalAccountID] = struct{}{}
	}
	accountSources := make(map[string][]int)
	for index, link := range links {
		for accountID := range link.accountIDs {
			accountSources[accountID] = append(accountSources[accountID], index)
		}
	}
	seenAccounts := make(map[string]struct{})
	result := make([]matchingComponent, 0)
	for accountID := range targetAccounts {
		if _, seen := seenAccounts[accountID]; seen {
			continue
		}
		if len(accountSources[accountID]) == 0 {
			continue
		}
		component := matchingComponent{accounts: make(map[string]struct{}), MatchesTarget: true}
		seenLinks := make(map[int]struct{})
		queue := []string{accountID}
		for len(queue) > 0 {
			current := queue[0]
			queue = queue[1:]
			if _, seen := component.accounts[current]; seen {
				continue
			}
			component.accounts[current] = struct{}{}
			seenAccounts[current] = struct{}{}
			if _, target := targetAccounts[current]; !target {
				component.MatchesTarget = false
			}
			for _, linkIndex := range accountSources[current] {
				if _, seen := seenLinks[linkIndex]; seen {
					continue
				}
				seenLinks[linkIndex] = struct{}{}
				link := links[linkIndex]
				component.links = append(component.links, link)
				if !link.fullyCoveredTarget {
					component.MatchesTarget = false
				}
				for linkedAccount := range link.accountIDs {
					if _, seen := component.accounts[linkedAccount]; !seen {
						queue = append(queue, linkedAccount)
					}
				}
			}
		}
		sort.Slice(component.links, func(a, b int) bool { return component.links[a].sourceID < component.links[b].sourceID })
		result = append(result, component)
	}
	sort.Slice(result, func(a, b int) bool {
		if len(result[a].links) == 0 || len(result[b].links) == 0 {
			return len(result[a].links) < len(result[b].links)
		}
		return result[a].links[0].sourceID < result[b].links[0].sourceID
	})
	return result
}

func loadFullCostLinks(ctx context.Context, database *sql.DB, series []domain.MatchingLimitSeries, start, end time.Time) ([]costLinkGroup, error) {
	accounts := make(map[string]struct{}, len(series))
	for _, item := range series {
		accounts[item.LogicalAccountID] = struct{}{}
	}
	rows, err := database.QueryContext(ctx, `SELECT usage_cost_source_id, usage_cost_association_id, logical_account_id, valid_from, valid_to FROM usage_cost_source_account_links WHERE valid_from < ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY usage_cost_source_id, usage_cost_association_id`, catalogPeriodText(end), catalogPeriodText(start))
	if err != nil {
		return nil, fmt.Errorf("list matching cost links: %w", err)
	}
	groups := make(map[string]*costLinkGroup)
	for rows.Next() {
		var sourceID, associationID, accountID, from string
		var to sql.NullString
		if err := rows.Scan(&sourceID, &associationID, &accountID, &from, &to); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan matching cost link: %w", err)
		}
		validFrom, err := parseUTC(from)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("parse matching cost link start: %w", err)
		}
		validTo, err := parseOptionalUTC(to)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("parse matching cost link end: %w", err)
		}
		group := groups[sourceID]
		if group == nil {
			group = &costLinkGroup{sourceID: sourceID, accountIDs: make(map[string]struct{}), fullyCoveredTarget: true}
			groups[sourceID] = group
		}
		group.associationIDs = append(group.associationIDs, associationID)
		group.accountIDs[accountID] = struct{}{}
		if validFrom.After(start) || (validTo != nil && end.After(*validTo)) {
			group.fullyCoveredTarget = false
		}
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matching cost links: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read matching cost links: %w", err)
	}
	result := make([]costLinkGroup, 0, len(groups))
	for _, group := range groups {
		intersects := false
		for accountID := range group.accountIDs {
			if _, ok := accounts[accountID]; ok {
				intersects = true
				break
			}
		}
		if !intersects {
			continue
		}
		result = append(result, *group)
	}
	sort.Slice(result, func(a, b int) bool { return result[a].sourceID < result[b].sourceID })
	return result, nil
}

func loadFullLimitAssociationIDs(ctx context.Context, database *sql.DB, sourceID, accountID string, start, end time.Time) ([]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT usage_limit_association_id, valid_from, valid_to FROM usage_limit_source_links WHERE usage_limit_source_id = ? AND logical_account_id = ? AND valid_from < ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY usage_limit_association_id`, sourceID, accountID, catalogPeriodText(end), catalogPeriodText(start))
	if err != nil {
		return nil, fmt.Errorf("list matching limit links: %w", err)
	}
	var result []string
	for rows.Next() {
		var id, from string
		var to sql.NullString
		if err := rows.Scan(&id, &from, &to); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan matching limit link: %w", err)
		}
		validFrom, err := parseUTC(from)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("parse matching limit link start: %w", err)
		}
		validTo, err := parseOptionalUTC(to)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("parse matching limit link end: %w", err)
		}
		if !validFrom.After(start) && (validTo == nil || !end.After(*validTo)) {
			result = append(result, id)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matching limit links: %w", err)
	}
	return uniqueMatchingStrings(result), rows.Err()
}

func loadMatchingLimitObservations(ctx context.Context, database *sql.DB, sourceID string, start, end time.Time) ([]domain.MatchingLimitObservation, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT o.observation_id, o.provider_updated_at, o.used_percent, o.sync_upload_interval_ms,
		       o.limits_refresh_ms, o.analytics_interval_seconds, o.normalization_generation,
		       o.normalization_rule_version, o.normalization_logic_version, o.dedupe_state
		FROM usage_limit_observations o
		JOIN usage_limit_sources s ON s.hub_id = o.hub_id AND s.device_id = o.device_id
		 AND s.account_key = o.account_key AND s.raw_service_identifier = o.raw_service_identifier
		 AND s.window_key = o.window_key AND s.normalized_kind = o.normalized_kind
		 AND s.normalized_metric = o.normalized_metric
		WHERE s.usage_limit_source_id = ? AND o.provider_updated_at >= ? AND o.provider_updated_at < ?
		ORDER BY o.provider_updated_at, o.observation_id`, sourceID, utcText(start), utcText(end))
	if err != nil {
		return nil, fmt.Errorf("list matching limit observations: %w", err)
	}
	var result []domain.MatchingLimitObservation
	for rows.Next() {
		var observation domain.MatchingLimitObservation
		var observed, syncMS, refreshMS sql.NullString
		var used sql.NullFloat64
		if err := rows.Scan(&observation.ID, &observed, &used, &syncMS, &refreshMS, &observation.AnalyticsIntervalSeconds, &observation.NormalizationGeneration, &observation.NormalizationRuleVersion, &observation.NormalizationLogicVersion, &observation.DedupeState); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan matching limit observation: %w", err)
		}
		observation.ObservedAt, _ = parseUTC(observed.String)
		observation.UsedPercent = matchingNullableFloat64(used)
		observation.SyncUploadIntervalMS = nullableInt64Text(syncMS)
		observation.LimitsRefreshMS = nullableInt64Text(refreshMS)
		result = append(result, observation)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matching limit observations: %w", err)
	}
	return result, rows.Err()
}

func loadMatchingCostObservations(ctx context.Context, database *sql.DB, sourceID string, start, end time.Time) ([]domain.MatchingCostObservation, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT o.observation_id, o.usage_updated_at, o.cost_usd_text,
		       o.sync_upload_interval_ms, o.analytics_interval_seconds,
		       o.normalization_generation, o.normalization_rule_version,
		       o.normalization_logic_version, o.dedupe_state, COALESCE(rs.api_contract, '')
		FROM usage_cost_observations o
		JOIN usage_cost_sources s ON s.hub_id = o.hub_id AND s.device_id = o.device_id
		 AND s.raw_service_identifier = o.raw_service_identifier
		LEFT JOIN raw_snapshots rs ON rs.snapshot_id = o.snapshot_id
		WHERE s.usage_cost_source_id = ? AND o.usage_updated_at >= ? AND o.usage_updated_at < ?
		ORDER BY o.usage_updated_at, o.observation_id`, sourceID, utcText(start), utcText(end))
	if err != nil {
		return nil, fmt.Errorf("list matching cost observations: %w", err)
	}
	var result []domain.MatchingCostObservation
	for rows.Next() {
		var observation domain.MatchingCostObservation
		var observed, syncMS sql.NullString
		var contract string
		if err := rows.Scan(&observation.ID, &observed, &observation.ValueText, &syncMS, &observation.AnalyticsIntervalSeconds, &observation.NormalizationGeneration, &observation.NormalizationRuleVersion, &observation.NormalizationLogicVersion, &observation.DedupeState, &contract); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan matching cost observation: %w", err)
		}
		observation.ObservedAt, _ = parseUTC(observed.String)
		observation.SyncUploadIntervalMS = nullableInt64Text(syncMS)
		// raw_snapshots.api_contract は収集時に確認済みの契約を保存する境界であり、ここで契約文字列を再解釈しない。
		observation.APIContractSupported = strings.TrimSpace(contract) != ""
		result = append(result, observation)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matching cost observations: %w", err)
	}
	return result, rows.Err()
}

func loadMatchingCompleteness(ctx context.Context, database *sql.DB, sourceID string, accounts map[string]struct{}, start, end time.Time) ([]string, bool, error) {
	rows, err := database.QueryContext(ctx, `SELECT completeness_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json FROM usage_cost_source_completeness WHERE usage_cost_source_id = ? AND valid_from < ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY valid_from, completeness_id`, sourceID, catalogPeriodText(end), catalogPeriodText(start))
	if err != nil {
		return nil, false, fmt.Errorf("list matching completeness: %w", err)
	}
	type completenessRow struct {
		id       string
		from     time.Time
		to       *time.Time
		state    domain.CompletenessState
		accounts map[string]struct{}
		excluded []string
	}
	var facts []completenessRow
	for rows.Next() {
		var fact completenessRow
		var from string
		var to sql.NullString
		var state, accountsJSON, excludedJSON string
		if err := rows.Scan(&fact.id, &from, &to, &state, &accountsJSON, &excludedJSON); err != nil {
			_ = rows.Close()
			return nil, false, fmt.Errorf("scan matching completeness: %w", err)
		}
		fact.from, err = parseUTC(from)
		if err != nil {
			_ = rows.Close()
			return nil, false, fmt.Errorf("parse matching completeness start: %w", err)
		}
		fact.to, err = parseOptionalUTC(to)
		if err != nil {
			_ = rows.Close()
			return nil, false, fmt.Errorf("parse matching completeness end: %w", err)
		}
		var accountIDs, excluded []string
		if err := json.Unmarshal([]byte(accountsJSON), &accountIDs); err != nil {
			return nil, false, fmt.Errorf("decode matching completeness accounts: %w", err)
		}
		if err := json.Unmarshal([]byte(excludedJSON), &excluded); err != nil {
			return nil, false, fmt.Errorf("decode matching completeness exclusions: %w", err)
		}
		fact.accounts = make(map[string]struct{}, len(accountIDs))
		for _, accountID := range accountIDs {
			fact.accounts[accountID] = struct{}{}
		}
		fact.state, fact.excluded = domain.CompletenessState(state), excluded
		facts = append(facts, fact)
	}
	if err := rows.Close(); err != nil {
		return nil, false, fmt.Errorf("close matching completeness: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, false, fmt.Errorf("read matching completeness: %w", err)
	}
	ids := make([]string, 0)
	for accountID := range accounts {
		cursor := start
		for cursor.Before(end) {
			var candidate *completenessRow
			for index := range facts {
				fact := &facts[index]
				if fact.from.After(cursor) || (fact.to != nil && !cursor.Before(*fact.to)) {
					continue
				}
				if _, ok := fact.accounts[accountID]; ok {
					candidate = fact
					break
				}
			}
			if candidate == nil || !matchingAccountSetsEqual(candidate.accounts, accounts) || candidate.state != domain.CompletenessConfirmed || len(candidate.excluded) != 0 {
				return uniqueMatchingStrings(ids), false, nil
			}
			ids = append(ids, candidate.id)
			next := end
			if candidate.to != nil && candidate.to.Before(next) {
				next = *candidate.to
			}
			if !cursor.Before(next) {
				return uniqueMatchingStrings(ids), false, nil
			}
			cursor = next
		}
	}
	return uniqueMatchingStrings(ids), true, nil
}

func matchingAccountSetsEqual(left, right map[string]struct{}) bool {
	if len(left) != len(right) {
		return false
	}
	for value := range left {
		if _, ok := right[value]; !ok {
			return false
		}
	}
	return true
}

func parseOptionalUTC(value sql.NullString) (*time.Time, error) {
	if !value.Valid || value.String == "" {
		return nil, nil
	}
	parsed, err := parseUTC(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func nullableInt64Text(value sql.NullString) *int64 {
	if !value.Valid || value.String == "" {
		return nil
	}
	parsed, err := strconv.ParseInt(value.String, 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func matchingNullableFloat64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	result := value.Float64
	return &result
}

func uniqueMatchingStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
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

func (l *Lifecycle) SaveEstimationPoints(ctx context.Context, points []domain.EstimationPoint) error {
	if len(points) == 0 {
		return nil
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin estimation point save: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, point := range points {
		if err := point.Validate(); err != nil {
			return err
		}
		intervalIDs, err := json.Marshal(uniqueMatchingStrings(point.CalculationIntervalIDs))
		if err != nil {
			return fmt.Errorf("encode estimation point intervals: %w", err)
		}
		limitIDs, err := json.Marshal(uniqueMatchingStrings(point.LimitSeriesIDs))
		if err != nil {
			return fmt.Errorf("encode estimation point limit sources: %w", err)
		}
		costIDs, err := json.Marshal(uniqueMatchingStrings(point.CostSourceIDs))
		if err != nil {
			return fmt.Errorf("encode estimation point cost sources: %w", err)
		}
		associationIDs, err := json.Marshal(uniqueMatchingStrings(point.AssociationIDs))
		if err != nil {
			return fmt.Errorf("encode estimation point associations: %w", err)
		}
		completenessIDs, err := json.Marshal(uniqueMatchingStrings(point.CompletenessIDs))
		if err != nil {
			return fmt.Errorf("encode estimation point completeness: %w", err)
		}
		utilization, err := json.Marshal(point.Utilization)
		if err != nil {
			return fmt.Errorf("encode estimation point utilization: %w", err)
		}
		limitAccountIDs, err := json.Marshal(point.LimitSeriesLogicalAccountIDs)
		if err != nil {
			return fmt.Errorf("encode estimation point logical accounts: %w", err)
		}
		limitPlanIDs, err := json.Marshal(point.LimitSeriesPlanVersionIDs)
		if err != nil {
			return fmt.Errorf("encode estimation point plan versions: %w", err)
		}
		limitIntervalIDs, err := json.Marshal(point.LimitSeriesCalculationIntervalIDs)
		if err != nil {
			return fmt.Errorf("encode estimation point series intervals: %w", err)
		}
		var storedID string
		err = tx.QueryRowContext(ctx, `SELECT estimation_point_id FROM estimation_points WHERE calculation_interval_id = ? AND reference_at = ? AND matching_rule_version = ? AND calculation_logic_version = ?`, point.CalculationIntervalID, utcText(point.ReferenceAt), point.MatchingRuleVersion, point.CalculationLogicVersion).Scan(&storedID)
		if errors.Is(err, sql.ErrNoRows) {
			storedID = point.ID
		} else if err != nil {
			return fmt.Errorf("read estimation point: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO estimation_points
				(estimation_point_id, service_id, limit_definition_id, plan_version_id, cycle_type,
				 calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost,
				 utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json,
				 limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json,
				 cost_source_ids_json, association_ids_json,
				 completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (calculation_interval_id, reference_at, matching_rule_version, calculation_logic_version)
			DO UPDATE SET service_id = excluded.service_id, limit_definition_id = excluded.limit_definition_id,
				plan_version_id = excluded.plan_version_id, cycle_type = excluded.cycle_type,
				calculation_interval_ids_json = excluded.calculation_interval_ids_json, shared_cost = excluded.shared_cost,
				utilization_json = excluded.utilization_json, limit_series_ids_json = excluded.limit_series_ids_json,
				limit_series_logical_account_ids_json = excluded.limit_series_logical_account_ids_json,
				limit_series_plan_version_ids_json = excluded.limit_series_plan_version_ids_json,
				limit_series_calculation_interval_ids_json = excluded.limit_series_calculation_interval_ids_json,
				cost_source_ids_json = excluded.cost_source_ids_json, association_ids_json = excluded.association_ids_json,
				completeness_ids_json = excluded.completeness_ids_json, updated_at = excluded.updated_at`,
			storedID, point.ServiceID, point.LimitDefinitionID, optionalIDString(point.PlanVersionID), point.CycleType,
			point.CalculationIntervalID, string(intervalIDs), utcText(point.ReferenceAt), point.SharedCost, string(utilization),
			string(limitIDs), string(limitAccountIDs), string(limitPlanIDs), string(limitIntervalIDs), string(costIDs), string(associationIDs), string(completenessIDs), point.MatchingRuleVersion,
			point.CalculationLogicVersion, utcText(point.CreatedAt), utcText(point.UpdatedAt)); err != nil {
			return fmt.Errorf("upsert estimation point: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM matched_observations WHERE estimation_point_id = ?`, storedID); err != nil {
			return fmt.Errorf("replace matched observations: %w", err)
		}
		for _, observation := range point.MatchedObservations {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO matched_observations
					(matched_observation_id, estimation_point_id, observation_role, source_id,
					 logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns,
					 analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms,
					 normalization_generation, normalization_rule_version, normalization_logic_version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				observation.ID, storedID, observation.Role, observation.SourceID, optionalIDString(observation.LogicalAccountID), observation.ObservationID,
				utcText(observation.ObservedAt), observation.TimeDelta.Nanoseconds(), observation.Tolerance.Nanoseconds(), observation.AnalyticsIntervalSeconds,
				optionalInt64(observation.SyncUploadIntervalMS), optionalInt64(observation.LimitsRefreshMS), observation.NormalizationGeneration,
				observation.NormalizationRuleVersion, observation.NormalizationLogicVersion); err != nil {
				return fmt.Errorf("insert matched observation: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit estimation points: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListEstimationPoints(ctx context.Context, calculationIntervalID string) ([]domain.EstimationPoint, error) {
	if strings.TrimSpace(calculationIntervalID) == "" {
		return nil, errors.New("calculation interval ID is required")
	}
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
	SELECT estimation_point_id, service_id, limit_definition_id, plan_version_id, cycle_type,
	       calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost,
	       utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json,
	       limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json,
	       cost_source_ids_json, association_ids_json,
		       completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at
		FROM estimation_points
		WHERE calculation_interval_id = ?
		   OR EXISTS (SELECT 1 FROM json_each(estimation_points.calculation_interval_ids_json) WHERE json_each.value = ?)
		ORDER BY reference_at, estimation_point_id`, calculationIntervalID, calculationIntervalID)
	if err != nil {
		return nil, fmt.Errorf("list estimation points: %w", err)
	}
	type pointRow struct {
		point                                                                                                        domain.EstimationPoint
		plan                                                                                                         sql.NullString
		intervals, utilization, limits, limitAccounts, limitPlans, limitIntervals, costs, associations, completeness string
		reference, created, updated                                                                                  string
	}
	var pointRows []pointRow
	for rows.Next() {
		var item pointRow
		if err := rows.Scan(&item.point.ID, &item.point.ServiceID, &item.point.LimitDefinitionID, &item.plan, &item.point.CycleType,
			&item.point.CalculationIntervalID, &item.intervals, &item.reference, &item.point.SharedCost, &item.utilization,
			&item.limits, &item.limitAccounts, &item.limitPlans, &item.limitIntervals, &item.costs, &item.associations, &item.completeness, &item.point.MatchingRuleVersion,
			&item.point.CalculationLogicVersion, &item.created, &item.updated); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan estimation point: %w", err)
		}
		pointRows = append(pointRows, item)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close estimation points: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read estimation points: %w", err)
	}
	result := make([]domain.EstimationPoint, 0, len(pointRows))
	for _, item := range pointRows {
		point := item.point
		if item.plan.Valid {
			point.PlanVersionID = item.plan.String
		}
		if err := json.Unmarshal([]byte(item.intervals), &point.CalculationIntervalIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point intervals: %w", err)
		}
		if err := json.Unmarshal([]byte(item.utilization), &point.Utilization); err != nil {
			return nil, fmt.Errorf("decode estimation point utilization: %w", err)
		}
		if err := json.Unmarshal([]byte(item.limits), &point.LimitSeriesIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point limits: %w", err)
		}
		if err := json.Unmarshal([]byte(item.limitAccounts), &point.LimitSeriesLogicalAccountIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point logical accounts: %w", err)
		}
		if err := json.Unmarshal([]byte(item.limitPlans), &point.LimitSeriesPlanVersionIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point plan versions: %w", err)
		}
		if err := json.Unmarshal([]byte(item.limitIntervals), &point.LimitSeriesCalculationIntervalIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point series intervals: %w", err)
		}
		if err := json.Unmarshal([]byte(item.costs), &point.CostSourceIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point costs: %w", err)
		}
		if err := json.Unmarshal([]byte(item.associations), &point.AssociationIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point associations: %w", err)
		}
		if err := json.Unmarshal([]byte(item.completeness), &point.CompletenessIDs); err != nil {
			return nil, fmt.Errorf("decode estimation point completeness: %w", err)
		}
		point.ReferenceAt, err = parseUTC(item.reference)
		if err != nil {
			return nil, fmt.Errorf("parse estimation point reference: %w", err)
		}
		point.CreatedAt, err = parseUTC(item.created)
		if err != nil {
			return nil, fmt.Errorf("parse estimation point creation: %w", err)
		}
		point.UpdatedAt, err = parseUTC(item.updated)
		if err != nil {
			return nil, fmt.Errorf("parse estimation point update: %w", err)
		}
		matched, err := l.listMatchedObservations(ctx, database, point.ID)
		if err != nil {
			return nil, err
		}
		point.MatchedObservations = matched
		if err := point.Validate(); err != nil {
			return nil, fmt.Errorf("validate estimation point: %w", err)
		}
		result = append(result, point)
	}
	return result, nil
}

// ListEstimationInput は保存済み観測点と正本の計算区間・プラン倍率を読む。
func (l *Lifecycle) ListEstimationInput(ctx context.Context, calculationIntervalID string) (domain.EstimationInput, error) {
	if strings.TrimSpace(calculationIntervalID) == "" {
		return domain.EstimationInput{}, errors.New("calculation interval ID is required")
	}
	points, err := l.ListEstimationPoints(ctx, calculationIntervalID)
	if err != nil {
		return domain.EstimationInput{}, err
	}
	allIntervals, err := l.ListCalculationIntervals(ctx, "")
	if err != nil {
		return domain.EstimationInput{}, err
	}
	intervalByID := make(map[string]domain.CalculationInterval, len(allIntervals))
	for _, candidate := range allIntervals {
		intervalByID[candidate.ID] = candidate
	}
	intervalIDs := []string{calculationIntervalID}
	ids := make([]string, 0)
	for _, point := range points {
		intervalIDs = append(intervalIDs, point.CalculationIntervalIDs...)
		intervalIDs = append(intervalIDs, point.LimitSeriesCalculationIntervalIDs...)
		ids = append(ids, point.LimitSeriesPlanVersionIDs...)
	}
	intervalIDs = uniqueMatchingStrings(intervalIDs)
	intervals := make([]domain.CalculationInterval, 0, len(intervalIDs))
	for _, id := range intervalIDs {
		interval, ok := intervalByID[id]
		if !ok {
			return domain.EstimationInput{}, fmt.Errorf("calculation interval %q was not found", id)
		}
		intervals = append(intervals, interval)
	}
	ids = uniqueMatchingStrings(ids)
	database, err := l.DB()
	if err != nil {
		return domain.EstimationInput{}, err
	}
	plans, err := loadEstimationPlanVersionsByIDs(ctx, database, ids)
	if err != nil {
		return domain.EstimationInput{}, err
	}
	return domain.EstimationInput{Points: points, Intervals: intervals, PlanVersions: plans}, nil
}

func (l *Lifecycle) listMatchedObservations(ctx context.Context, database *sql.DB, pointID string) ([]domain.MatchedObservation, error) {
	rows, err := database.QueryContext(ctx, `SELECT matched_observation_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version FROM matched_observations WHERE estimation_point_id = ? ORDER BY observation_role, source_id, observation_id, matched_observation_id`, pointID)
	if err != nil {
		return nil, fmt.Errorf("list matched observations: %w", err)
	}
	var result []domain.MatchedObservation
	for rows.Next() {
		var item domain.MatchedObservation
		var account sql.NullString
		var observed string
		var timeDelta, tolerance int64
		var syncMS, refreshMS sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Role, &item.SourceID, &account, &item.ObservationID, &observed, &timeDelta, &tolerance, &item.AnalyticsIntervalSeconds, &syncMS, &refreshMS, &item.NormalizationGeneration, &item.NormalizationRuleVersion, &item.NormalizationLogicVersion); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("scan matched observation: %w", err)
		}
		item.LogicalAccountID = account.String
		item.ObservedAt, err = parseUTC(observed)
		if err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("parse matched observation time: %w", err)
		}
		item.TimeDelta = time.Duration(timeDelta)
		item.Tolerance = time.Duration(tolerance)
		item.SyncUploadIntervalMS = matchingNullableSQLInt64(syncMS)
		item.LimitsRefreshMS = matchingNullableSQLInt64(refreshMS)
		result = append(result, item)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close matched observations: %w", err)
	}
	return result, rows.Err()
}

func optionalInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func matchingNullableSQLInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	result := value.Int64
	return &result
}
