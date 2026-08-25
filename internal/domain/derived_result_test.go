package domain

import (
	"math"
	"testing"
	"time"
)

func TestBuildAdjacentDifferenceRowsRetainsEveryExclusionReason(t *testing.T) {
	base := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	points := []EstimationPoint{
		{ID: "p0", ReferenceAt: base, SharedCost: 1, Utilization: []float64{0}},
		{ID: "p1", ReferenceAt: base.Add(time.Minute), SharedCost: 2, Utilization: []float64{0.1}},
		{ID: "p2", ReferenceAt: base.Add(2 * time.Minute), SharedCost: 3, Utilization: []float64{0}},
		{ID: "p3", ReferenceAt: base.Add(3 * time.Minute), SharedCost: 3, Utilization: []float64{0}},
		{ID: "p4", ReferenceAt: base.Add(4 * time.Minute), SharedCost: 2, Utilization: []float64{0.2}},
		{ID: "p5", ReferenceAt: base.Add(5 * time.Minute), SharedCost: 4, Utilization: []float64{0.3}},
		{ID: "p6", ReferenceAt: base.Add(6 * time.Minute), SharedCost: math.NaN(), Utilization: []float64{0.4}},
		{ID: "p7", ReferenceAt: base.Add(7 * time.Minute), SharedCost: 5, Utilization: []float64{0.5, 0.6}},
	}
	rows := BuildAdjacentDifferenceRows(points)
	counts := map[string]int{}
	for _, row := range rows {
		if row.Accepted {
			counts["accepted"]++
		} else {
			counts[row.ExclusionReason]++
		}
	}
	want := map[string]int{"accepted": 2, "negative_utilization_delta": 1, "zero_delta": 1, "negative_cost": 1, "non_finite_value": 1, "target_set_mismatch": 1}
	if len(rows) != 7 {
		t.Fatalf("difference row count = %d, want 7", len(rows))
	}
	for reason, expected := range want {
		if counts[reason] != expected {
			t.Fatalf("difference reason %q count = %d, want %d", reason, counts[reason], expected)
		}
	}
}

func TestComputeInputFingerprintIsDeterministicAndIncludesFacts(t *testing.T) {
	syncMS, refreshMS := int64(100), int64(200)
	point := EstimationPoint{
		ID: "point-1", ServiceID: "service-1", LimitDefinitionID: "definition-1", CalculationIntervalID: "interval-1",
		ReferenceAt: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), SharedCost: 1.5, Utilization: []float64{0.25},
		CalculationIntervalIDs: []string{"interval-1"}, LimitSeriesIDs: []string{"limit-1"}, LimitSeriesLogicalAccountIDs: []string{"account-1"}, LimitSeriesPlanVersionIDs: []string{"plan-1"}, LimitSeriesCalculationIntervalIDs: []string{"interval-1"}, CostSourceIDs: []string{"cost-1"}, AssociationIDs: []string{"association-1"}, CompletenessIDs: []string{"completeness-1"},
		MatchedObservations: []MatchedObservation{{ID: "matched-1", Role: MatchingRoleLimit, SourceID: "source-1", LogicalAccountID: "account-1", ObservationID: "observation-1", ObservedAt: time.Date(2026, 8, 1, 0, 1, 0, 0, time.UTC), TimeDelta: time.Second, Tolerance: 2 * time.Second, AnalyticsIntervalSeconds: 60, SyncUploadIntervalMS: &syncMS, LimitsRefreshMS: &refreshMS, NormalizationGeneration: 1, NormalizationRuleVersion: "normalization-1", NormalizationLogicVersion: "normalization-logic-1"}},
	}
	rows := []EstimationDifferenceRow{{ID: "row-1", StartPointID: "point-0", EndPointID: "point-1", Cost: 1.5, Coefficients: []float64{0.25}, Accepted: true}}
	evidence := []EstimationEvidence{{ID: "evidence-1", Kind: "plan_history", PointID: "point-1", AssociationID: "association-1", CompletenessID: "completeness-1", PlanHistoryID: "history-1", LogicalAccountID: "account-1", PlanVersionID: "plan-1", DetailsJSON: `{"validFrom":"2026-08-01T00:00:00Z"}`}}
	ruleLimit, ruleMultiplier := 100.0, 1.5
	rule := PlanLimitRule{ID: "rule-1", PlanVersionID: "plan-1", LimitDefinitionID: "definition-1", Limit: &ruleLimit, Multiplier: &ruleMultiplier, OfficialSourceURL: "https://example.test/rule"}
	baseline, err := ComputeInputFingerprint([]EstimationPoint{point}, rows, evidence, []float64{1.5}, []string{"rule-1"}, "matching-1", "logic-1", rule)
	if err != nil {
		t.Fatal(err)
	}
	pointCopy := point
	pointCopy.MatchedObservations = append([]MatchedObservation(nil), point.MatchedObservations...)
	evidenceCopy := append([]EstimationEvidence(nil), evidence...)
	reordered, err := ComputeInputFingerprint([]EstimationPoint{pointCopy}, append([]EstimationDifferenceRow(nil), rows...), evidenceCopy, []float64{1.5}, []string{"rule-1"}, "matching-1", "logic-1", rule)
	if err != nil || reordered != baseline {
		t.Fatalf("fingerprint changed for equivalent ordered input: got %q want %q err=%v", reordered, baseline, err)
	}
	cases := []struct {
		name   string
		mutate func(*EstimationPoint, *EstimationEvidence, *PlanLimitRule, *[]float64)
	}{
		{name: "normalization", mutate: func(p *EstimationPoint, _ *EstimationEvidence, _ *PlanLimitRule, _ *[]float64) {
			p.MatchedObservations[0].NormalizationRuleVersion = "normalization-2"
		}},
		{name: "association", mutate: func(p *EstimationPoint, _ *EstimationEvidence, _ *PlanLimitRule, _ *[]float64) {
			p.AssociationIDs = []string{"association-2"}
		}},
		{name: "completeness", mutate: func(p *EstimationPoint, _ *EstimationEvidence, _ *PlanLimitRule, _ *[]float64) {
			p.CompletenessIDs = []string{"completeness-2"}
		}},
		{name: "plan history", mutate: func(_ *EstimationPoint, e *EstimationEvidence, _ *PlanLimitRule, _ *[]float64) {
			e.PlanHistoryID = "history-2"
		}},
		{name: "rule", mutate: func(_ *EstimationPoint, _ *EstimationEvidence, r *PlanLimitRule, _ *[]float64) {
			value := 101.0
			r.Limit = &value
		}},
		{name: "multiplier", mutate: func(_ *EstimationPoint, _ *EstimationEvidence, _ *PlanLimitRule, m *[]float64) { *m = []float64{2} }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			changedPoint := point
			changedPoint.MatchedObservations = append([]MatchedObservation(nil), point.MatchedObservations...)
			changedEvidence := append([]EstimationEvidence(nil), evidence...)
			changedRule := rule
			multipliers := []float64{1.5}
			testCase.mutate(&changedPoint, &changedEvidence[0], &changedRule, &multipliers)
			changed, err := ComputeInputFingerprint([]EstimationPoint{changedPoint}, rows, changedEvidence, multipliers, []string{"rule-1"}, "matching-1", "logic-1", changedRule)
			if err != nil {
				t.Fatal(err)
			}
			if changed == baseline {
				t.Fatalf("fingerprint did not change for %s", testCase.name)
			}
		})
	}
}

func TestRecalculationScopeRejectsUnknownAndNonArrayFields(t *testing.T) {
	if _, err := DecodeRecalculationScope(`{"serviceID":"service-1"}`); err == nil {
		t.Fatal("unknown scope field was accepted")
	}
	if _, err := DecodeRecalculationScope(`{"serviceIDs":"service-1"}`); err == nil {
		t.Fatal("scalar scope field was accepted")
	}
	encoded, err := EncodeRecalculationScope(RecalculationScope{})
	if err != nil {
		t.Fatal(err)
	}
	if encoded != `{"serviceIDs":[],"definitionIDs":[],"accountIDs":[],"sourceIDs":[],"costSourceIDs":[],"intervalIDs":[]}` {
		t.Fatalf("empty scope = %s", encoded)
	}
	partial, err := EncodeRecalculationScope(RecalculationScope{ServiceIDs: []string{"service-b", "service-a"}, CostSourceIDs: []string{"cost-1"}})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeRecalculationScope(partial)
	if err != nil || len(decoded.ServiceIDs) != 2 || decoded.ServiceIDs[0] != "service-a" || len(decoded.CostSourceIDs) != 1 || decoded.CostSourceIDs[0] != "cost-1" {
		t.Fatalf("scope roundtrip: encoded=%s decoded=%+v err=%v", partial, decoded, err)
	}
}
