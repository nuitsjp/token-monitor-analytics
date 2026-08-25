package sqlite

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestT031SQLiteMatchingFixturePersistsCompletePointAndSharedCostOnce(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	middle := start.Add(time.Hour)
	end := start.Add(2 * time.Hour)
	hubID := insertAccountTestHub(t, lifecycle, start, "matching-fixture-hub")
	service := testCatalogService(start, "matching-fixture-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	accounts := []LogicalAccount{{ID: "matching-account-a", ServiceID: service.ID, DisplayName: "A", CreatedAt: start, UpdatedAt: start}, {ID: "matching-account-b", ServiceID: service.ID, DisplayName: "B", CreatedAt: start, UpdatedAt: start}}
	for _, account := range accounts {
		if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
			t.Fatal(err)
		}
	}
	definition := LimitDefinition{ID: "matching-definition", ServiceID: service.ID, CycleType: domain.LimitCycleWeekly, Meaning: "tokens", Unit: "percent", CreatedAt: start, UpdatedAt: start}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	limitSources := []UsageLimitSource{{ID: "matching-limit-source-a", HubID: hubID, DeviceID: "device-a", AccountKey: "account-a", RawServiceIdentifier: "limit.raw", WindowKey: "weekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", CreatedAt: start}, {ID: "matching-limit-source-b", HubID: hubID, DeviceID: "device-b", AccountKey: "account-b", RawServiceIdentifier: "limit.raw", WindowKey: "weekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", CreatedAt: start}}
	for index, source := range limitSources {
		if err := lifecycle.CreateUsageLimitSource(ctx, source); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "matching-limit-link-" + time.Duration(index).String(), UsageLimitSourceID: source.ID, LogicalAccountID: accounts[index].ID, LimitDefinitionID: definition.ID, ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}); err != nil {
			t.Fatal(err)
		}
		planVersionID := "matching-plan"
		if index == 1 {
			planVersionID = "matching-plan-b"
		}
		if err := lifecycle.SaveCalculationIntervals(ctx, []domain.CalculationInterval{{ID: "matching-interval-" + time.Duration(index).String(), ServiceID: service.ID, LogicalAccountID: accounts[index].ID, UsageLimitSourceID: source.ID, LimitDefinitionID: definition.ID, PlanVersionID: planVersionID, CycleType: domain.LimitCycleWeekly, ValidFrom: start, ValidTo: end, State: domain.CalculationEstimable, CreatedAt: start, UpdatedAt: start}}, nil); err != nil {
			t.Fatal(err)
		}
	}
	costSource := UsageCostSource{ID: "matching-cost-source", HubID: hubID, DeviceID: "cost-device", RawServiceIdentifier: "cost.raw", CreatedAt: start}
	if err := lifecycle.CreateUsageCostSource(ctx, costSource); err != nil {
		t.Fatal(err)
	}
	for index, account := range accounts {
		if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "matching-cost-link-" + time.Duration(index).String(), UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}); err != nil {
			t.Fatal(err)
		}
	}
	if err := lifecycle.CreateUsageCostSourceCompleteness(ctx, UsageCostSourceCompleteness{ID: "matching-completeness", UsageCostSourceID: costSource.ID, ValidFrom: start, ValidTo: &end, State: CompletenessConfirmed, LogicalAccountIDs: []string{accounts[0].ID, accounts[1].ID}, CreatedAt: start, UpdatedAt: start}); err != nil {
		t.Fatal(err)
	}
	contract := "hub-client-contract-2026"
	sync := int64(0)
	refresh := int64(10_000)
	used := [][]float64{{10, 20}, {30, 40}}
	observedAt := []time.Time{start, middle}
	for index, observed := range observedAt {
		attemptID := "matching-attempt-" + time.Duration(index).String()
		snapshotID := "matching-snapshot-" + time.Duration(index).String()
		if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: observed, AnalyticsIntervalSeconds: 1}); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: observed, ReceivedCompletedAt: observed.Add(time.Second), HTTPStatus: 200, APIContract: contract, Body: []byte(`{"stats":true}`)}); err != nil {
			t.Fatal(err)
		}
		costTime := observed
		costValue := "10"
		if index == 1 {
			costTime = middle.Add(-2 * time.Second)
			costValue = "18"
		}
		costs := []CostObservation{{ObservationID: "matching-cost-observation-" + time.Duration(index).String(), SnapshotID: snapshotID, HubID: hubID, DeviceID: costSource.DeviceID, RawServiceIdentifier: costSource.RawServiceIdentifier, UsageUpdatedAt: costTime, CostUSDText: costValue, SyncUploadIntervalMS: &sync, AnalyticsIntervalSeconds: 1, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", JSONPath: "$.cost", DedupeKey: "matching-cost-key-" + time.Duration(index).String(), ValueFingerprint: costValue}}
		limits := []LimitObservation{{ObservationID: "matching-limit-observation-a-" + time.Duration(index).String(), SnapshotID: snapshotID, HubID: hubID, DeviceID: limitSources[0].DeviceID, RawServiceIdentifier: limitSources[0].RawServiceIdentifier, AccountKey: limitSources[0].AccountKey, ProviderUpdatedAt: observed, WindowKey: limitSources[0].WindowKey, NormalizedKind: limitSources[0].NormalizedKind, NormalizedMetric: limitSources[0].NormalizedMetric, NormalizedLabel: limitSources[0].NormalizedLabel, PlanLabel: "Plan", UsedPercent: &used[index][0], SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, AnalyticsIntervalSeconds: 1, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", JSONPath: "$.limit.a", DedupeKey: "matching-limit-key-a-" + time.Duration(index).String(), ValueFingerprint: "a"}, {ObservationID: "matching-limit-observation-b-" + time.Duration(index).String(), SnapshotID: snapshotID, HubID: hubID, DeviceID: limitSources[1].DeviceID, RawServiceIdentifier: limitSources[1].RawServiceIdentifier, AccountKey: limitSources[1].AccountKey, ProviderUpdatedAt: observed, WindowKey: limitSources[1].WindowKey, NormalizedKind: limitSources[1].NormalizedKind, NormalizedMetric: limitSources[1].NormalizedMetric, NormalizedLabel: limitSources[1].NormalizedLabel, PlanLabel: "Plan", UsedPercent: &used[index][1], SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, AnalyticsIntervalSeconds: 1, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", JSONPath: "$.limit.b", DedupeKey: "matching-limit-key-b-" + time.Duration(index).String(), ValueFingerprint: "b"}}
		if index == 1 {
			costs = append(costs, CostObservation{ObservationID: "matching-cost-future", SnapshotID: snapshotID, HubID: hubID, DeviceID: costSource.DeviceID, RawServiceIdentifier: costSource.RawServiceIdentifier, UsageUpdatedAt: middle.Add(2 * time.Second), CostUSDText: "19", SyncUploadIntervalMS: &sync, AnalyticsIntervalSeconds: 1, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", JSONPath: "$.cost.future", DedupeKey: "matching-cost-future-key", ValueFingerprint: "19"})
		}
		if err := lifecycle.InsertObservations(ctx, costs, limits); err != nil {
			t.Fatal(err)
		}
	}
	inputs, err := lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 1 {
		t.Fatalf("matching inputs = %#v", inputs)
	}
	if inputs[0].PlanVersionID != "" || len(inputs[0].LimitSeries) != 2 || inputs[0].LimitSeries[0].PlanVersionID == inputs[0].LimitSeries[1].PlanVersionID {
		t.Fatalf("plan versions were collapsed: %#v", inputs[0])
	}
	nextID := 0
	points, err := domain.BuildEstimationPoints(inputs[0], func() string {
		nextID++
		return "matching-point-" + time.Duration(nextID).String()
	}, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 2 || points[1].MatchedObservations[2].ObservationID != "matching-cost-observation-1ns" || points[1].SharedCost != 18 || len(points[1].Utilization) != 2 || points[1].Utilization[0] != 0.3 || points[1].Utilization[1] != 0.4 {
		t.Fatalf("points = %#v", points)
	}
	if err := lifecycle.SaveEstimationPoints(ctx, points); err != nil {
		t.Fatal(err)
	}
	persisted, err := lifecycle.ListEstimationPoints(ctx, "matching-interval-0s")
	if err != nil {
		t.Fatal(err)
	}
	if len(persisted) != 2 || persisted[1].SharedCost != points[1].SharedCost || len(persisted[1].Utilization) != 2 || len(persisted[1].MatchedObservations) != 3 {
		t.Fatalf("persisted points = %#v", persisted)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE estimation_points SET utilization_json = '[0.3]' WHERE estimation_point_id = ?`, persisted[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.ListEstimationPoints(ctx, "matching-interval-0s"); err == nil {
		t.Fatal("expected utilization length validation error")
	}
	if _, err := database.Exec(`UPDATE estimation_points SET utilization_json = '[0.3, 1.2]' WHERE estimation_point_id = ?`, persisted[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.ListEstimationPoints(ctx, "matching-interval-0s"); err == nil {
		t.Fatal("expected utilization range validation error")
	}
	if _, err := database.Exec(`UPDATE estimation_points SET utilization_json = ? WHERE estimation_point_id = ?`, `[0.3, 0.4]`, persisted[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE raw_snapshots SET api_contract = ''`); err != nil {
		t.Fatal(err)
	}
	inputs, err = lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	points, err = domain.BuildEstimationPoints(inputs[0], func() string { return "unsupported" }, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("unsupported contract points = %#v", points)
	}
	if _, err := database.Exec(`UPDATE raw_snapshots SET api_contract = ?`, contract); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE usage_cost_observations SET dedupe_state = 'conflict'`); err != nil {
		t.Fatal(err)
	}
	inputs, err = lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	points, err = domain.BuildEstimationPoints(inputs[0], func() string { return "conflict" }, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("dedupe conflict points = %#v", points)
	}
	if _, err := database.Exec(`UPDATE usage_cost_observations SET dedupe_state = 'canonical'`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE usage_cost_source_completeness SET logical_account_ids_json = ?`, `["matching-account-a"]`); err != nil {
		t.Fatal(err)
	}
	inputs, err = lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 1 || len(inputs[0].CostSources) != 1 || inputs[0].CostSources[0].Complete {
		t.Fatalf("partial completeness account set was accepted: %#v", inputs)
	}
	points, err = domain.BuildEstimationPoints(inputs[0], func() string { return "partial-completeness" }, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("partial completeness points = %#v", points)
	}
	if _, err := database.Exec(`UPDATE usage_cost_source_completeness SET logical_account_ids_json = ?`, `["matching-account-a","matching-account-b"]`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE usage_cost_source_completeness SET state = 'unconfirmed'`); err != nil {
		t.Fatal(err)
	}
	inputs, err = lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	points, err = domain.BuildEstimationPoints(inputs[0], func() string { return "incomplete" }, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("incomplete points = %#v", points)
	}
	extraAccount := LogicalAccount{ID: "matching-account-extra", ServiceID: service.ID, DisplayName: "extra", CreatedAt: start, UpdatedAt: start}
	if err := lifecycle.CreateLogicalAccount(ctx, extraAccount); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "matching-cost-link-extra", UsageCostSourceID: costSource.ID, LogicalAccountID: extraAccount.ID, ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}); err != nil {
		t.Fatal(err)
	}
	inputs, err = lifecycle.ListCalculationMatchingInputs(ctx, domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: start, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	if len(inputs) != 1 || inputs[0].Eligible {
		t.Fatalf("mixed cost account set was eligible: %#v", inputs)
	}
	points, err = domain.BuildEstimationPoints(inputs[0], func() string { return "mixed-accounts" }, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("mixed cost account points = %#v", points)
	}
}

func TestT031MatchingComponentsSeparateDedicatedCostSources(t *testing.T) {
	series := []domain.MatchingLimitSeries{{LogicalAccountID: "account-a"}, {LogicalAccountID: "account-b"}}
	links := []costLinkGroup{{sourceID: "cost-a", accountIDs: map[string]struct{}{"account-a": {}}, fullyCoveredTarget: true}, {sourceID: "cost-b", accountIDs: map[string]struct{}{"account-b": {}}, fullyCoveredTarget: true}}
	components := matchingComponents(series, links)
	if len(components) != 2 {
		t.Fatalf("components = %#v, want two independent components", components)
	}
	for _, component := range components {
		if !component.MatchesTarget || len(component.accounts) != 1 || len(component.links) != 1 {
			t.Fatalf("component = %#v", component)
		}
	}
}
