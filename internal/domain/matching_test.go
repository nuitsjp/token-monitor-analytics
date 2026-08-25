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
	t.Run("P1-MATCH-04 nearest complete observations form a point", func(t *testing.T) {
		matched := points[0].MatchedObservations
		if len(matched) != 2 || matched[0].ObservationID != "limit-observation" || matched[1].ObservationID != "cost-past" {
			t.Fatalf("matched observations = %#v", matched)
		}
		if points[0].ReferenceAt != now || points[0].SharedCost != 10 || len(points[0].Utilization) != 1 || points[0].Utilization[0] != 0.1 {
			t.Fatalf("matched point = %#v", points[0])
		}
	})
	t.Run("P1-MATCH-05 equal distance prefers past and duplicate source timestamps reject", func(t *testing.T) {
		if points[0].MatchedObservations[1].ObservationID != "cost-past" {
			t.Fatalf("equal-distance observation = %#v", points[0].MatchedObservations)
		}
		duplicate := input
		duplicate.CostSources = []MatchingCostSource{{UsageCostSourceID: "cost-source", Complete: true, Observations: []MatchingCostObservation{{ID: "cost-a", ObservedAt: now, ValueText: "10", APIContractSupported: true, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}, {ID: "cost-b", ObservedAt: now, ValueText: "11", APIContractSupported: true, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "norm-rule-v1", NormalizationLogicVersion: "norm-logic-v1", DedupeState: "canonical"}}}}
		got, err := BuildEstimationPoints(duplicate, testMatchingIDs(), now)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("duplicate timestamp points = %#v", got)
		}
	})
	t.Run("P1-MATCH-08 point retains source IDs deltas tolerances and versions", func(t *testing.T) {
		if points[0].ReferenceAt != now || len(points[0].CalculationIntervalIDs) != 1 || points[0].CalculationIntervalIDs[0] != "interval" {
			t.Fatalf("point target metadata = %#v", points[0])
		}
		associationIDs := map[string]bool{}
		for _, id := range points[0].AssociationIDs {
			associationIDs[id] = true
		}
		if len(associationIDs) != 2 || !associationIDs["cost-link"] || !associationIDs["limit-link"] || len(points[0].CompletenessIDs) != 1 || points[0].CompletenessIDs[0] != "complete" {
			t.Fatalf("point association/completeness metadata = %#v", points[0])
		}
		for _, observation := range points[0].MatchedObservations {
			if observation.TimeDelta < 0 || observation.Tolerance <= 0 || observation.AnalyticsIntervalSeconds <= 0 || observation.SyncUploadIntervalMS == nil {
				t.Fatalf("matched metadata = %#v", observation)
			}
		}
		if points[0].MatchingRuleVersion != MatchingRuleVersion || points[0].CalculationLogicVersion != CalculationLogicVersion {
			t.Fatalf("point versions = %#v", points[0])
		}
	})
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
	t.Run("P1-MATCH-02 missing or invalid acquisition metadata excludes the pair", func(t *testing.T) {
		invalid := base
		invalid.LimitSeries = append([]MatchingLimitSeries(nil), base.LimitSeries...)
		invalid.LimitSeries[0].Observations = append([]MatchingLimitObservation(nil), base.LimitSeries[0].Observations...)
		invalid.LimitSeries[0].Observations[0].SyncUploadIntervalMS = nil
		got, err := BuildEstimationPoints(invalid, testMatchingIDs(), now)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 0 {
			t.Fatalf("missing sync interval produced points = %#v", got)
		}
	})
	t.Run("P1-MATCH-06 incomplete source sets produce no partial point", func(t *testing.T) {
		if points, err := BuildEstimationPoints(base, testMatchingIDs(), now); err != nil {
			t.Fatal(err)
		} else if len(points) != 0 {
			t.Fatalf("incomplete source set produced points = %#v", points)
		}
	})
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
	t.Run("P1-MATCH-07 duplicate input tuples deduplicate while source reuse remains allowed", func(t *testing.T) {
		if len(points) != 2 || points[0].MatchedObservations[1].ObservationID != "cost-1" || points[1].MatchedObservations[1].ObservationID != "cost-1" {
			t.Fatalf("deduplicated source reuse = %#v", points)
		}
	})
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
	t.Run("P1-MATCH-01 tolerance is the maximum of effective source intervals", func(t *testing.T) {
		if points[0].MatchedObservations[0].Tolerance != 2*time.Second || points[0].MatchedObservations[1].Tolerance != 2*time.Second || points[0].MatchedObservations[2].Tolerance != 10*time.Second {
			t.Fatalf("effective tolerance maximums = %#v", points[0].MatchedObservations)
		}
		for _, observation := range points[0].MatchedObservations {
			if observation.SyncUploadIntervalMS == nil {
				t.Fatalf("sync interval was not retained: %#v", observation)
			}
		}
		candidate := input
		candidate.LimitSeries = append([]MatchingLimitSeries(nil), input.LimitSeries...)
		candidate.LimitSeries[0].Observations = append([]MatchingLimitObservation(nil), input.LimitSeries[0].Observations...)
		limitSync, limitRefresh, costSync := int64(12_000), int64(13_000), int64(11_000)
		candidate.LimitSeries[0].Observations[0].SyncUploadIntervalMS = &limitSync
		candidate.LimitSeries[0].Observations[0].LimitsRefreshMS = &limitRefresh
		candidate.CostSources = append([]MatchingCostSource(nil), input.CostSources...)
		candidate.CostSources[0].Observations = append([]MatchingCostObservation(nil), input.CostSources[0].Observations...)
		candidate.CostSources[0].Observations[0].SyncUploadIntervalMS = &costSync
		wide, err := BuildEstimationPoints(candidate, testMatchingIDs(), now)
		if err != nil {
			t.Fatal(err)
		}
		if len(wide) != 1 {
			t.Fatalf("maximum interval candidate = %#v", wide)
		}
		for _, observation := range wide[0].MatchedObservations {
			if observation.Tolerance != 13*time.Second {
				t.Fatalf("maximum tolerance = %#v", wide[0].MatchedObservations)
			}
		}
	})
}

func ptrFloat(value float64) *float64 { return &value }

func testMatchingIDs() func() string {
	value := 0
	return func() string {
		value++
		return "matching-id-" + time.Duration(value).String()
	}
}
