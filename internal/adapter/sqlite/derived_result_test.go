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
	base := domain.DerivedResult{ID: "derived-old", ServiceID: service.ID, LimitDefinitionID: definition.ID, CycleType: domain.LimitCycleWeekly, CalculationIntervalIDs: []string{"interval-a"}, ValidFrom: now, ValidTo: now.Add(time.Hour), EstimationResult: domain.EstimationResult{Status: domain.EstimationProvisional, CalculationLogicVersion: "logic-old"}, Series: []domain.EstimationResultSeries{{ID: "derived-series", UsageLimitSourceID: "source-a", LogicalAccountID: "account-a", PlanVersionID: "plan-a"}}, CreatedAt: now, UpdatedAt: now}
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
}

func TestClaimRecalculationRequestIsAtomic(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	if _, err := database.Exec(`INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id) VALUES ('audit-recalc', ?, 'test', 'test', 'test', 'test')`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO recalculation_requests (request_id, audit_id, requested_at, interval_start, interval_end, scope_json, state) VALUES ('request-recalc', 'audit-recalc', ?, ?, ?, '{"serviceIDs":[],"definitionIDs":[],"accountIDs":[],"sourceIDs":[],"costSourceIDs":[],"intervalIDs":["interval-a"]}', 'pending')`, utcText(now), utcText(now), utcText(now.Add(time.Hour))); err != nil {
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
		if _, err := database.Exec(statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	request := domain.RecalculationRequest{IntervalStart: now.Add(30 * time.Minute), IntervalEnd: now.Add(time.Hour), ScopeJSON: `{"serviceIDs":["scope-service"],"definitionIDs":["scope-definition"],"accountIDs":["scope-account-a"],"sourceIDs":["scope-source-a"],"costSourceIDs":[],"intervalIDs":[]}`}
	if err := lifecycle.Recalculate(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM estimation_results`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("scoped recalculation result count = %d, want 1", count)
	}
	var intervalIDs string
	if err := database.QueryRow(`SELECT calculation_interval_ids_json FROM estimation_results`).Scan(&intervalIDs); err != nil {
		t.Fatal(err)
	}
	if intervalIDs != `[`+`"scope-interval-a"`+`]` {
		t.Fatalf("scoped interval IDs = %s", intervalIDs)
	}
	if _, err := database.Exec(`DELETE FROM estimation_results`); err != nil {
		t.Fatal(err)
	}
	costScope := domain.RecalculationRequest{IntervalStart: now.Add(30 * time.Minute), IntervalEnd: now.Add(time.Hour), ScopeJSON: `{"serviceIDs":["scope-service"],"definitionIDs":["scope-definition"],"accountIDs":["scope-account-a"],"sourceIDs":[],"costSourceIDs":["cost-source-a"],"intervalIDs":[]}`}
	if err := lifecycle.Recalculate(context.Background(), costScope); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM estimation_results`).Scan(&count); err != nil {
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
	if err := database.QueryRow(`SELECT scope_json FROM recalculation_requests WHERE request_id = (SELECT request_id FROM configuration_audits WHERE entity_type = 'catalog_service' AND entity_id = 'scoped-service' ORDER BY occurred_at DESC LIMIT 1)`).Scan(&scopeJSON); err != nil {
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
