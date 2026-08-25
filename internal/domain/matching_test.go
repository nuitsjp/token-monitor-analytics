package domain

import (
	"testing"
	"time"
)

func TestT031BuildEstimationPointsUsesPastOnEqualDistanceAndStoresMetadata(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	past := now.Add(-2 * time.Second)
	future := now.Add(2 * time.Second)
	sync := int64(0)
	refresh := int64(1_000)
	input := CalculationMatchingInput{
		ServiceID: "service", LimitDefinitionID: "definition", PlanVersionID: "plan", CycleType: LimitCycleWeekly,
		CalculationIntervalIDs: []string{"interval"}, ValidFrom: now.Add(-time.Minute), ValidTo: now.Add(time.Minute), Eligible: true,
		LimitSeries: []MatchingLimitSeries{{CalculationIntervalID: "interval", LogicalAccountID: "account", UsageLimitSourceID: "limit-source", AssociationIDs: []string{"limit-link"}, CompletenessIDs: []string{"complete"}, Observations: []MatchingLimitObservation{{ID: "limit-observation", ObservedAt: now, UsedPercent: ptrFloat(10), AnalyticsIntervalSeconds: 10, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
		CostSources: []MatchingCostSource{{UsageCostSourceID: "cost-source", AssociationIDs: []string{"cost-link"}, CompletenessIDs: []string{"complete"}, Complete: true, Observations: []MatchingCostObservation{{ID: "cost-past", ObservedAt: past, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}, {ID: "cost-future", ObservedAt: future, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
	}
	points, err := BuildEstimationPoints(input, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || len(points[0].MatchedObservations) != 2 {
		t.Fatalf("points = %#v", points)
	}
	if points[0].MatchedObservations[1].ObservationID != "cost-past" {
		t.Fatalf("matched observations = %#v, want past cost observation", points[0].MatchedObservations)
	}
	if points[0].SharedCost != 10 || len(points[0].Utilization) != 1 || points[0].Utilization[0] != 0.1 {
		t.Fatalf("numeric point = %#v, want shared cost 10 and utilization 0.1", points[0])
	}
	if points[0].MatchingRuleVersion != MatchingRuleVersion || points[0].CalculationLogicVersion != CalculationLogicVersion {
		t.Fatalf("versions = %#v", points[0])
	}
	if points[0].MatchedObservations[1].Tolerance != 10*time.Second {
		t.Fatalf("tolerance = %s, want 10s", points[0].MatchedObservations[1].Tolerance)
	}
}

func TestT031BuildEstimationPointsRequiresEverySeriesAndSource(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	sync := int64(300_000)
	refresh := int64(300_000)
	base := CalculationMatchingInput{
		ServiceID: "service", LimitDefinitionID: "definition", PlanVersionID: "plan", CycleType: LimitCycleWeekly,
		CalculationIntervalIDs: []string{"interval"}, ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), Eligible: true,
		LimitSeries: []MatchingLimitSeries{{CalculationIntervalID: "interval", LogicalAccountID: "account", UsageLimitSourceID: "limit-source", Observations: []MatchingLimitObservation{{ID: "limit-observation", ObservedAt: now, UsedPercent: ptrFloat(10), AnalyticsIntervalSeconds: 300, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
		CostSources: []MatchingCostSource{{UsageCostSourceID: "cost-source", Complete: false, Observations: []MatchingCostObservation{{ID: "cost-observation", ObservedAt: now, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 300, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
	}
	points, err := BuildEstimationPoints(base, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("incomplete points = %#v", points)
	}
	base.CostSources[0].Complete = true
	base.CostSources[0].Observations[0].APIContractSupported = false
	points, err = BuildEstimationPoints(base, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("unsupported contract points = %#v", points)
	}
	base.CostSources[0].Observations[0].APIContractSupported = true
	base.CostSources[0].Observations[0].ObservedAt = time.Time{}
	points, err = BuildEstimationPoints(base, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("invalid time points = %#v", points)
	}
}

func TestT031BuildEstimationPointsRejectsDuplicateObservationAndAllowsSourceReuse(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	sync := int64(0)
	refresh := int64(1)
	input := CalculationMatchingInput{
		ServiceID: "service", LimitDefinitionID: "definition", PlanVersionID: "plan", CycleType: LimitCycleWeekly,
		CalculationIntervalIDs: []string{"interval"}, ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), Eligible: true,
		LimitSeries: []MatchingLimitSeries{{CalculationIntervalID: "interval", LogicalAccountID: "account", UsageLimitSourceID: "limit-source", Observations: []MatchingLimitObservation{{ID: "limit-1", ObservedAt: now, UsedPercent: ptrFloat(10), AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}, {ID: "limit-2", ObservedAt: now.Add(time.Minute), UsedPercent: ptrFloat(20), AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
		CostSources: []MatchingCostSource{{UsageCostSourceID: "cost-source", Complete: true, Observations: []MatchingCostObservation{{ID: "cost-1", ObservedAt: now, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 600, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}, {ID: "cost-duplicate", ObservedAt: now, ValueText: "11", APIContractSupported: true, AnalyticsIntervalSeconds: 600, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}},
	}
	points, err := BuildEstimationPoints(input, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("duplicate timestamp points = %#v", points)
	}
	input.CostSources[0].Observations = input.CostSources[0].Observations[:1]
	points, err = BuildEstimationPoints(input, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 2 || points[0].MatchedObservations[1].ObservationID != "cost-1" || points[1].MatchedObservations[1].ObservationID != "cost-1" {
		t.Fatalf("source-reused points = %#v", points)
	}
}

func TestT031MatchedToleranceStoresEffectiveMinimumAcrossSources(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	sync := int64(0)
	refresh := int64(1)
	input := CalculationMatchingInput{
		ServiceID: "service", LimitDefinitionID: "definition", PlanVersionID: "plan", CycleType: LimitCycleWeekly,
		CalculationIntervalIDs: []string{"interval"}, ValidFrom: now.Add(-time.Minute), ValidTo: now.Add(time.Minute), Eligible: true,
		LimitSeries: []MatchingLimitSeries{{CalculationIntervalID: "interval", LogicalAccountID: "account", UsageLimitSourceID: "limit-source", Observations: []MatchingLimitObservation{{ID: "limit-observation", ObservedAt: now, UsedPercent: ptrFloat(10), AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", DedupeState: "canonical"}}}},
		CostSources: []MatchingCostSource{{UsageCostSourceID: "cost-slow", Complete: true, Observations: []MatchingCostObservation{{ID: "cost-slow-observation", ObservedAt: now, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 10, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", DedupeState: "canonical"}}}, {UsageCostSourceID: "cost-fast", Complete: true, Observations: []MatchingCostObservation{{ID: "cost-fast-observation", ObservedAt: now, ValueText: "5", APIContractSupported: true, AnalyticsIntervalSeconds: 2, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", DedupeState: "canonical"}}}},
	}
	points, err := BuildEstimationPoints(input, testMatchingIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].SharedCost != 15 {
		t.Fatalf("points = %#v", points)
	}
	if points[0].MatchedObservations[0].Tolerance != 2*time.Second || points[0].MatchedObservations[1].Tolerance != 2*time.Second || points[0].MatchedObservations[2].Tolerance != 10*time.Second {
		t.Fatalf("effective tolerances = %#v", points[0].MatchedObservations)
	}
}

func ptrFloat(value float64) *float64 { return &value }

func testMatchingIDs() func() string {
	value := 0
	return func() string {
		value++
		return "matching-id-" + time.Duration(value).String()
	}
}
