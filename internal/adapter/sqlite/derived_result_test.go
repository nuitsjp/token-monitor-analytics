package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestSaveDerivedResultReplacesByResultSetKeyAndRollsBack(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "derived-result-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	definition := LimitDefinition{ID: "derived-result-definition", ServiceID: service.ID, CycleType: domain.LimitCycleWeekly, Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	base := domain.DerivedResult{ID: "derived-old", ServiceID: service.ID, LimitDefinitionID: definition.ID, CycleType: domain.LimitCycleWeekly, CalculationIntervalIDs: []string{"interval-a"}, ValidFrom: now, ValidTo: now.Add(time.Hour), EstimationResult: domain.EstimationResult{Status: domain.EstimationEstimated, Reasons: []string{"positive_unique_solution"}, Limits: []float64{100}, Rank: 1, MaxTimeDelta: 2 * time.Second, CalculationLogicVersion: "logic-old", PointIDs: []string{"point-a"}}, Series: []domain.EstimationResultSeries{{ID: "derived-series", UsageLimitSourceID: "source-a", LogicalAccountID: "account-a", PlanVersionID: "plan-a"}}, Evidence: []domain.EstimationEvidence{{ID: "point-evidence", Kind: "point", PointID: "point-a"}, {ID: "matched-evidence", Kind: "matched_observation", PointID: "point-a", ObservationID: "observation-a"}, {ID: "snapshot-evidence", Kind: "snapshot", PointID: "point-a", SnapshotID: "snapshot-a"}, {ID: "association-evidence", Kind: "association", PointID: "point-a", AssociationID: "association-a"}, {ID: "completeness-evidence", Kind: "completeness", PointID: "point-a", CompletenessID: "completeness-a"}, {ID: "plan-history-evidence", Kind: "plan_history", PointID: "point-a", PlanHistoryID: "history-a", PlanVersionID: "plan-a"}}, CreatedAt: now, UpdatedAt: now}
	base.ResultSetKey = domain.ResultSetKey(base.ServiceID, base.LimitDefinitionID, base.CycleType, base.ValidFrom, base.ValidTo, base.CalculationIntervalIDs)
	if err := lifecycle.SaveDerivedResult(ctx, base, nil); err != nil {
		t.Fatal(err)
	}
	updated := base
	updated.ID = "derived-new"
	updated.CalculationLogicVersion = "logic-new"
	if err := lifecycle.SaveDerivedResult(ctx, updated, derivedFailAt("after-result")); err == nil {
		t.Fatal("injected replacement unexpectedly succeeded")
	}
	stored, err := lifecycle.GetEstimationResult(ctx, base.ResultSetKey)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != base.ID || stored.CalculationLogicVersion != base.CalculationLogicVersion {
		t.Fatalf("old result was not retained after rollback: %#v", stored)
	}
	if len(stored.Series) != 1 || stored.Series[0].Multiplier != nil || stored.Series[0].EstimatedLimit != nil {
		t.Fatalf("unknown multiplier/limit was not retained as NULL: %#v", stored.Series)
	}
	t.Run("P1-RES-01 persisted result retains identity metrics and calculation version", func(t *testing.T) {
		if stored.ServiceID != service.ID || stored.LimitDefinitionID != definition.ID || stored.CycleType != domain.LimitCycleWeekly || len(stored.CalculationIntervalIDs) != 1 || stored.CalculationIntervalIDs[0] != "interval-a" || stored.Status != domain.EstimationEstimated || len(stored.Limits) != 1 || stored.Limits[0] != 100 || stored.Rank != 1 || stored.MaxTimeDelta != 2*time.Second || stored.CalculationLogicVersion != "logic-old" {
			t.Fatalf("persisted result metadata = %#v", stored)
		}
		if len(stored.Series) != 1 || stored.Series[0].LogicalAccountID != "account-a" || stored.Series[0].PlanVersionID != "plan-a" {
			t.Fatalf("persisted series metadata = %#v", stored.Series)
		}
	})
	t.Run("P1-RES-02 result evidence retains point source snapshot and lineage links", func(t *testing.T) {
		kinds := map[string]bool{}
		for _, evidence := range stored.Evidence {
			kinds[evidence.Kind] = true
		}
		for _, kind := range []string{"point", "matched_observation", "snapshot", "association", "completeness", "plan_history"} {
			if !kinds[kind] {
				t.Fatalf("missing evidence kind %q: %#v", kind, stored.Evidence)
			}
		}
	})
	if err := lifecycle.SaveDerivedResult(ctx, updated, nil); err != nil {
		t.Fatal(err)
	}
	stored, err = lifecycle.GetEstimationResult(ctx, base.ResultSetKey)
	if err != nil {
		t.Fatal(err)
	}
	if stored.ID != updated.ID || stored.CalculationLogicVersion != updated.CalculationLogicVersion {
		t.Fatalf("result was not replaced: %#v", stored)
	}
	t.Run("P1-RES-03 same result set key replaces the derived generation", func(t *testing.T) {
		if stored.ID != updated.ID || stored.CalculationLogicVersion != updated.CalculationLogicVersion {
			t.Fatalf("derived result generation was not replaced: %#v", stored)
		}
		if _, err := lifecycle.GetEstimationResult(ctx, base.ResultSetKey); err != nil {
			t.Fatal(err)
		}
	})
}

func TestClaimRecalculationRequestIsAtomic(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	if _, err := database.ExecContext(context.Background(), `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id) VALUES ('audit-recalc', ?, 'test', 'test', 'test', 'test')`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(context.Background(), `INSERT INTO recalculation_requests (request_id, audit_id, requested_at, interval_start, interval_end, scope_json, state) VALUES ('request-recalc', 'audit-recalc', ?, ?, ?, '{"serviceIDs":[],"definitionIDs":[],"accountIDs":[],"sourceIDs":[],"costSourceIDs":[],"intervalIDs":["interval-a"]}', 'pending')`, utcText(now), utcText(now), utcText(now.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	request, claimed, err := lifecycle.ClaimRecalculationRequest(context.Background(), "worker-a")
	if err != nil || !claimed {
		t.Fatalf("claim = %#v, %v, %v", request, claimed, err)
	}
	if request.ScopeJSON != `{"serviceIDs":[],"definitionIDs":[],"accountIDs":[],"sourceIDs":[],"costSourceIDs":[],"intervalIDs":["interval-a"]}` || request.State != "running" {
		t.Fatalf("claim did not retain scope/state: %#v", request)
	}
	_, claimed, err = lifecycle.ClaimRecalculationRequest(context.Background(), "worker-b")
	if err != nil {
		t.Fatal(err)
	}
	if claimed {
		t.Fatal("running request was claimed twice")
	}
	if err := lifecycle.CompleteRecalculationRequest(context.Background(), request.RequestID); err != nil {
		t.Fatal(err)
	}
}

func TestMatchingInputForIntervalPrefersTargetSeries(t *testing.T) {
	input := domain.CalculationMatchingInput{
		CalculationIntervalIDs: []string{"interval-a", "interval-b", "interval-c"},
		LimitSeries: []domain.MatchingLimitSeries{
			{CalculationIntervalID: "interval-a", LogicalAccountID: "account", UsageLimitSourceID: "source-a", PlanVersionID: "plan"},
			{CalculationIntervalID: "interval-b", LogicalAccountID: "account", UsageLimitSourceID: "source-b", PlanVersionID: "plan"},
			{CalculationIntervalID: "interval-c", LogicalAccountID: "other-account", UsageLimitSourceID: "source-c", PlanVersionID: "plan"},
		},
	}

	selected, ok := matchingInputForInterval(input, "interval-b")
	if !ok {
		t.Fatal("duplicate target series was not selected")
	}
	if len(selected.LimitSeries) != 2 || selected.LimitSeries[0].CalculationIntervalID != "interval-b" || selected.LimitSeries[0].UsageLimitSourceID != "source-b" || selected.LimitSeries[1].CalculationIntervalID != "interval-c" {
		t.Fatalf("selected series = %#v", selected.LimitSeries)
	}
	if len(selected.CalculationIntervalIDs) != 2 || selected.CalculationIntervalIDs[0] != "interval-b" || selected.CalculationIntervalIDs[1] != "interval-c" || selected.PlanVersionID != "plan" {
		t.Fatalf("selected target metadata = %#v", selected)
	}

	input.LimitSeries = append(input.LimitSeries, domain.MatchingLimitSeries{CalculationIntervalID: "interval-d", LogicalAccountID: "other-account", UsageLimitSourceID: "source-d", PlanVersionID: "plan"})
	if _, ok := matchingInputForInterval(input, "interval-b"); ok {
		t.Fatal("unrelated duplicate series was resolved arbitrarily")
	}
}

func TestRecalculateStaleDerivedResultsHandlesDuplicateLogicalAccountIntervals(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	hubID := insertAccountTestHub(t, lifecycle, start, "duplicate-series-hub")
	service := testCatalogService(start, "duplicate-series-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	account := LogicalAccount{ID: "duplicate-series-account", ServiceID: service.ID, DisplayName: "Account", CreatedAt: start, UpdatedAt: start}
	if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	definition := LimitDefinition{ID: "duplicate-series-definition", ServiceID: service.ID, CycleType: domain.LimitCycleWeekly, Meaning: "tokens", Unit: "percent", CreatedAt: start, UpdatedAt: start}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	intervals := make([]domain.CalculationInterval, 0, 2)
	for _, device := range []string{"home-main", "home-mini"} {
		source := UsageLimitSource{ID: "duplicate-series-source-" + device, HubID: hubID, DeviceID: device, AccountKey: "account-key", RawServiceIdentifier: "limit.raw", WindowKey: "weekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", CreatedAt: start}
		if err := lifecycle.CreateUsageLimitSource(ctx, source); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "duplicate-series-link-" + device, UsageLimitSourceID: source.ID, LogicalAccountID: account.ID, LimitDefinitionID: definition.ID, ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}); err != nil {
			t.Fatal(err)
		}
		intervals = append(intervals, domain.CalculationInterval{ID: "duplicate-series-interval-" + device, ServiceID: service.ID, LogicalAccountID: account.ID, UsageLimitSourceID: source.ID, LimitDefinitionID: definition.ID, CycleType: domain.LimitCycleWeekly, ValidFrom: start, ValidTo: end, State: domain.CalculationEstimable, CreatedAt: start, UpdatedAt: start})
	}
	if err := lifecycle.CreateUsageCostSource(ctx, UsageCostSource{ID: "duplicate-series-cost", HubID: hubID, DeviceID: "cost-device", RawServiceIdentifier: "cost.raw", CreatedAt: start}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "duplicate-series-cost-link", UsageCostSourceID: "duplicate-series-cost", LogicalAccountID: account.ID, ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveCalculationIntervals(ctx, intervals, nil); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.RecalculateStaleDerivedResults(ctx); err != nil {
		t.Fatalf("stale derived result rebuild failed: %v", err)
	}
	for _, interval := range intervals {
		key := domain.ResultSetKey(service.ID, definition.ID, domain.LimitCycleWeekly, start, end, []string{interval.ID})
		result, err := lifecycle.GetEstimationResult(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.CalculationIntervalIDs) != 1 || result.CalculationIntervalIDs[0] != interval.ID || len(result.Series) != 1 || result.Series[0].LogicalAccountID != account.ID || result.Series[0].UsageLimitSourceID != interval.UsageLimitSourceID {
			t.Fatalf("result for %s = %#v", interval.ID, result)
		}
	}
}

func TestRecalculateScopeFiltersIntervalsByConfirmedIDs(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('scope-service', 'provider', 'service', 'scope-service', ?, ?)`,
		`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('scope-definition', 'scope-service', 'weekly', 'tokens', 'percent', 'not_applicable', ?, ?)`,
		`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('scope-account-a', 'scope-service', 'A', ?, ?)`,
		`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('scope-account-b', 'scope-service', 'B', ?, ?)`,
		`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('scope-hub', 'hub', 'http://127.0.0.1:1', 0, 300, ?, ?)`,
		`INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cost-source-a', 'scope-hub', 'device-a', 'cost.raw', ?)`,
		`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('scope-source-a', 'scope-hub', 'device-a', 'account-a', 'limit.raw', 'window-a', 'weekly', 'percent', 'A', ?)`,
		`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('scope-source-b', 'scope-hub', 'device-b', 'account-b', 'limit.raw', 'window-b', 'weekly', 'percent', 'B', ?)`,
		`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('scope-interval-a', 'scope-service', 'scope-account-a', 'scope-source-a', 'scope-definition', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`,
		`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('scope-interval-b', 'scope-service', 'scope-account-b', 'scope-source-b', 'scope-definition', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`,
	} {
		var args []any
		switch {
		case strings.Contains(statement, "scope-interval-a"):
			args = []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}
		case strings.Contains(statement, "scope-interval-b"):
			args = []any{utcText(now.Add(time.Hour)), utcText(now.Add(2 * time.Hour)), utcText(now), utcText(now)}
		default:
			args = []any{utcText(now), utcText(now)}
			if strings.Contains(statement, "usage_limit_sources") || strings.Contains(statement, "usage_cost_sources") {
				args = []any{utcText(now)}
			}
		}
		if _, err := database.ExecContext(context.Background(), statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	request := domain.RecalculationRequest{IntervalStart: now.Add(30 * time.Minute), IntervalEnd: now.Add(time.Hour), ScopeJSON: `{"serviceIDs":["scope-service"],"definitionIDs":["scope-definition"],"accountIDs":["scope-account-a"],"sourceIDs":["scope-source-a"],"costSourceIDs":[],"intervalIDs":[]}`}
	if err := lifecycle.Recalculate(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM estimation_results`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("scoped recalculation result count = %d, want 1", count)
	}
	var intervalIDs string
	if err := database.QueryRowContext(t.Context(), `SELECT calculation_interval_ids_json FROM estimation_results`).Scan(&intervalIDs); err != nil {
		t.Fatal(err)
	}
	if intervalIDs != `[`+`"scope-interval-a"`+`]` {
		t.Fatalf("scoped interval IDs = %s", intervalIDs)
	}
	if _, err := database.ExecContext(context.Background(), `DELETE FROM estimation_results`); err != nil {
		t.Fatal(err)
	}
	costScope := domain.RecalculationRequest{IntervalStart: now.Add(30 * time.Minute), IntervalEnd: now.Add(time.Hour), ScopeJSON: `{"serviceIDs":["scope-service"],"definitionIDs":["scope-definition"],"accountIDs":["scope-account-a"],"sourceIDs":[],"costSourceIDs":["cost-source-a"],"intervalIDs":[]}`}
	if err := lifecycle.Recalculate(context.Background(), costScope); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM estimation_results`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("cost-scoped recalculation result count = %d, want 1", count)
	}
}

func TestCatalogMutationScopeTargetsAffectedService(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	if err := lifecycle.CreateService(context.Background(), domain.Service{ID: "scoped-service", Provider: "provider", Name: "service", OfficialKey: "scoped-service", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	var scopeJSON string
	if err := database.QueryRowContext(t.Context(), `SELECT scope_json FROM recalculation_requests WHERE request_id = (SELECT request_id FROM configuration_audits WHERE entity_type = 'catalog_service' AND entity_id = 'scoped-service' ORDER BY occurred_at DESC LIMIT 1)`).Scan(&scopeJSON); err != nil {
		t.Fatal(err)
	}
	want := `{"serviceIDs":["scoped-service"],"definitionIDs":[],"accountIDs":[],"sourceIDs":[],"costSourceIDs":[],"intervalIDs":[]}`
	if scopeJSON != want {
		t.Fatalf("catalog scope = %s, want %s", scopeJSON, want)
	}
}

type derivedFailAt string

func (f derivedFailAt) Check(point string) error {
	if string(f) == point {
		return errors.New("injected")
	}
	return nil
}
