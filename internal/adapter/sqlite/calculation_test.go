package sqlite

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type calculationIntegrationIDs struct{ next int }

func (g *calculationIntegrationIDs) New() string {
	g.next++
	return "calculation-integration-id-" + time.Duration(g.next).String()
}

func TestT030SQLiteCalculationFixtureUsesConfirmedFactsAndPersistsBoundaries(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := now.Add(7 * 24 * time.Hour)
	hubID := insertAccountTestHub(t, lifecycle, now, "calculation-fixture-hub")
	service := testCatalogService(now, "calculation-fixture-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	for _, mapping := range []ServiceIdentifierMapping{
		{ID: "calculation-cost-mapping", Kind: domain.UsageCostIdentifier, RawIdentifier: "cost.raw", ServiceID: service.ID, ValidFrom: now.Add(-time.Hour), ValidTo: &end, CreatedAt: now},
		{ID: "calculation-limit-mapping", Kind: domain.UsageLimitIdentifier, RawIdentifier: "limit.raw", ServiceID: service.ID, ValidFrom: now.Add(-time.Hour), ValidTo: &end, CreatedAt: now},
	} {
		if err := lifecycle.CreateServiceIdentifierMapping(ctx, mapping); err != nil {
			t.Fatal(err)
		}
	}
	for _, mapping := range []ServiceIdentifierMapping{
		{ID: "calculation-cost-mapping-next", Kind: domain.UsageCostIdentifier, RawIdentifier: "cost.raw", ServiceID: service.ID, ValidFrom: end, CreatedAt: now},
		{ID: "calculation-limit-mapping-next", Kind: domain.UsageLimitIdentifier, RawIdentifier: "limit.raw", ServiceID: service.ID, ValidFrom: end, CreatedAt: now},
	} {
		if err := lifecycle.CreateServiceIdentifierMapping(ctx, mapping); err != nil {
			t.Fatal(err)
		}
	}
	account := LogicalAccount{ID: "calculation-account", ServiceID: service.ID, DisplayName: "Account", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	plan := Plan{ID: "calculation-plan", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	version := PlanVersion{ID: "calculation-version", PlanID: plan.ID, Name: "Version", ValidFrom: now, ValidTo: &end, OfficialSourceURL: "https://vendor.example/plan", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "calculation-history", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	definition := LimitDefinition{ID: "calculation-definition", ServiceID: service.ID, CycleType: domain.LimitCycleWeekly, Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	limitSource := UsageLimitSource{ID: "calculation-limit-source", HubID: hubID, DeviceID: "device", AccountKey: "account-key", RawServiceIdentifier: "limit.raw", WindowKey: "weekly-window", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", CreatedAt: now}
	if err := lifecycle.CreateUsageLimitSource(ctx, limitSource); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "calculation-limit-link", UsageLimitSourceID: limitSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: definition.ID, ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	costSource := UsageCostSource{ID: "calculation-cost-source", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cost.raw", CreatedAt: now}
	if err := lifecycle.CreateUsageCostSource(ctx, costSource); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "calculation-cost-link", UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostSourceCompleteness(ctx, UsageCostSourceCompleteness{ID: "calculation-completeness", UsageCostSourceID: costSource.ID, ValidFrom: now, ValidTo: &end, State: CompletenessConfirmed, LogicalAccountIDs: []string{account.ID}, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for index, observedAt := range []time.Time{now, end} {
		attemptID, snapshotID := "calculation-attempt-"+time.Duration(index+1).String(), "calculation-snapshot-"+time.Duration(index+1).String()
		if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: observedAt, AnalyticsIntervalSeconds: 300}); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: observedAt, ReceivedCompletedAt: observedAt.Add(time.Second), HTTPStatus: 200, APIContract: "contract-a", Body: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		costValue := "10"
		if index == 1 {
			costValue = "12"
		}
		reset := observedAt
		if err := lifecycle.InsertObservations(ctx, []CostObservation{{ObservationID: "calculation-cost-observation-" + time.Duration(index+1).String(), UsageCostSourceID: costSource.ID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cost.raw", UsageUpdatedAt: observedAt, CostUSDText: costValue, AnalyticsIntervalSeconds: 300, JSONPath: "$.cost", DedupeKey: "calculation-cost-dedupe-" + time.Duration(index+1).String(), ValueFingerprint: costValue}}, []LimitObservation{{ObservationID: "calculation-limit-observation-" + time.Duration(index+1).String(), UsageLimitSourceID: limitSource.ID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: "limit.raw", AccountKey: "account-key", ProviderUpdatedAt: observedAt, WindowKey: "weekly-window", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", PlanLabel: "Plan", ResetsAt: &reset, AnalyticsIntervalSeconds: 300, JSONPath: "$.limit", DedupeKey: "calculation-limit-dedupe-" + time.Duration(index+1).String(), ValueFingerprint: "limit-" + time.Duration(index+1).String()}}); err != nil {
			t.Fatal(err)
		}
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	request := domain.CalculationBuildRequest{ServiceID: service.ID, ValidFrom: now, ValidTo: end}
	series, err := lifecycle.ListCalculationSeries(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	var intervals []domain.CalculationInterval
	var boundaries []domain.CalculationBoundary
	ids := &calculationIntegrationIDs{}
	for _, item := range series {
		derived, derivedBoundaries, deriveErr := domain.DeriveCalculationIntervals(item, request, ids.New, now)
		if deriveErr != nil {
			t.Fatal(deriveErr)
		}
		intervals = append(intervals, derived...)
		boundaries = append(boundaries, derivedBoundaries...)
	}
	if err := lifecycle.SaveCalculationIntervals(ctx, intervals, boundaries); err != nil {
		t.Fatal(err)
	}
	if len(intervals) != 1 || intervals[0].State != domain.CalculationEstimable || intervals[0].PlanVersionID != version.ID {
		t.Fatalf("calculation intervals = %#v", intervals)
	}
	persisted, err := lifecycle.ListCalculationIntervals(ctx, limitSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	boundaries, err = lifecycle.ListCalculationBoundaries(ctx, limitSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	resetBoundaries := 0
	for _, boundary := range boundaries {
		if boundary.Kind == domain.BoundaryReset {
			resetBoundaries++
		}
	}
	if len(persisted) != 1 || resetBoundaries != 2 {
		t.Fatalf("persisted intervals=%#v boundaries=%#v", persisted, boundaries)
	}
	var requests int
	if err := database.QueryRowContext(context.Background(), `SELECT count(*) FROM recalculation_requests WHERE interval_start = ? AND interval_end = ?`, catalogPeriodText(now), catalogPeriodText(end)).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if requests == 0 {
		t.Fatal("calculation interval did not create a recalculation request")
	}
}
