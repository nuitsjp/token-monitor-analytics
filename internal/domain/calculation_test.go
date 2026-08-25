package domain

import (
	"testing"
	"time"
)

func TestT030CalculationIntervalsUseHalfOpenPlanAndCompletenessBoundaries(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := now.Add(7 * 24 * time.Hour)
	middle := now.Add(3 * 24 * time.Hour)
	series := calculationTestSeries(now, end)
	series.PlanHistories = []PlanHistory{
		{ID: "history-a", LogicalAccountID: "account", PlanVersionID: "plan-a", ValidFrom: now, ValidTo: &middle, CreatedAt: now, UpdatedAt: now},
		{ID: "history-b", LogicalAccountID: "account", PlanVersionID: "plan-b", ValidFrom: middle, ValidTo: &end, CreatedAt: now, UpdatedAt: now},
	}
	series.CostSources[0].Completeness = []CalculationCompleteness{
		{ID: "complete-a", ValidFrom: now, ValidTo: &middle, State: CompletenessConfirmed, LogicalAccountIDs: []string{"account"}},
		{ID: "complete-b", ValidFrom: middle, ValidTo: &end, State: CompletenessUnconfirmed, LogicalAccountIDs: []string{"account"}},
	}
	intervals, boundaries, err := DeriveCalculationIntervals(series, CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: end}, testCalculationIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(intervals) != 2 {
		t.Fatalf("intervals = %#v, want two half-open segments", intervals)
	}
	if intervals[0].State != CalculationEstimable || intervals[0].PlanVersionID != "plan-a" || !intervals[0].ValidTo.Equal(middle) {
		t.Fatalf("first interval = %#v", intervals[0])
	}
	if intervals[1].State != CalculationExcluded || intervals[1].ExclusionReason != ExclusionCompletenessUnconfirmed || intervals[1].PlanVersionID != "plan-b" || !intervals[1].ValidFrom.Equal(middle) {
		t.Fatalf("second interval = %#v", intervals[1])
	}
	if len(boundaries) < 4 {
		t.Fatalf("boundaries = %#v, want reset, plan and completeness boundaries", boundaries)
	}
}

func TestT030CalculationIntervalsExcludeUnsupportedCyclesWithReasons(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := now.Add(time.Hour)
	for _, test := range []struct {
		cycle  string
		reason CalculationExclusionReason
	}{
		{LimitCycleSession, ExclusionSessionCycle},
		{LimitCycleFiveHour, ExclusionFiveHourCycle},
		{LimitCycleBalance, ExclusionBalanceCycle},
		{LimitCycleCredit, ExclusionCreditCycle},
		{LimitCycleUsage, ExclusionUsageCycle},
		{LimitCycleCredits, ExclusionCreditsCycle},
		{LimitCycleSpend, ExclusionSpendCycle},
		{LimitCycleBilling, ExclusionBillingUnconfirmed},
	} {
		t.Run(test.cycle, func(t *testing.T) {
			series := calculationTestSeries(now, end)
			series.CycleType = test.cycle
			intervals, _, err := DeriveCalculationIntervals(series, CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: end}, testCalculationIDs(), now)
			if err != nil {
				t.Fatal(err)
			}
			if len(intervals) != 1 || intervals[0].State != CalculationExcluded || intervals[0].ExclusionReason != test.reason {
				t.Fatalf("intervals = %#v, want reason %q", intervals, test.reason)
			}
		})
	}
	series := calculationTestSeries(now, end)
	series.CycleType, series.BillingConfirmation = LimitCycleBilling, BillingConfirmed
	intervals, _, err := DeriveCalculationIntervals(series, CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: end}, testCalculationIDs(), now)
	if err != nil || len(intervals) != 1 || intervals[0].State != CalculationEstimable {
		t.Fatalf("confirmed billing intervals = %#v err=%v", intervals, err)
	}
}

func TestT030HubSwitchMismatchExcludesOnlyTheCurrentResetCycle(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	firstEnd := now.Add(time.Hour)
	secondEnd := now.Add(2 * time.Hour)
	series := calculationTestSeries(now, secondEnd)
	series.Observations = []CalculationObservation{
		{ID: "o0", ObservedAt: now, ResetAt: timePtr(now)},
		{ID: "o1", ObservedAt: firstEnd, ResetAt: timePtr(firstEnd)},
		{ID: "o2", ObservedAt: secondEnd, ResetAt: timePtr(secondEnd)},
	}
	switchAt := now.Add(30 * time.Minute)
	series.HubSwitches = []HubSwitch{{ID: "switch", OldHubID: "old", OldDeviceID: "d1", NewHubID: "new", NewDeviceID: "d2", CollectionDeviceID: "collector", SwitchedAt: switchAt, CreatedAt: now}}
	intervals, boundaries, err := DeriveCalculationIntervals(series, CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: secondEnd}, testCalculationIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(intervals) != 3 || intervals[0].ExclusionReason != ExclusionHubSwitchWithoutReset || intervals[1].ExclusionReason != ExclusionHubSwitchWithoutReset || intervals[2].State != CalculationEstimable {
		t.Fatalf("Hub switch intervals = %#v", intervals)
	}
	if !hasCalculationBoundary(boundaries, BoundaryHubSwitch, switchAt) {
		t.Fatalf("Hub switch boundary missing: %#v", boundaries)
	}
}

func TestT030UnexplainedDecreaseAndAPIContractChangeDoNotCrossIntervals(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := now.Add(4 * time.Hour)
	series := calculationTestSeries(now, end)
	series.Observations = []CalculationObservation{
		{ID: "o0", ObservedAt: now, ResetAt: timePtr(now), APIContract: "a"},
		{ID: "o1", ObservedAt: now.Add(time.Hour), ResetAt: timePtr(now), APIContract: "a"},
		{ID: "o2", ObservedAt: now.Add(2 * time.Hour), ResetAt: timePtr(now), APIContract: "b"},
		{ID: "o3", ObservedAt: now.Add(3 * time.Hour), ResetAt: timePtr(now), APIContract: "b"},
		{ID: "o4", ObservedAt: end, ResetAt: timePtr(end), APIContract: "b"},
	}
	series.CostSources[0].Observations = []CalculationCostObservation{
		{ID: "c0", ObservedAt: now, ValueText: "10"},
		{ID: "c1", ObservedAt: now.Add(time.Hour), ValueText: "12"},
		{ID: "c2", ObservedAt: now.Add(3 * time.Hour), ValueText: "8"},
	}
	intervals, boundaries, err := DeriveCalculationIntervals(series, CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: end}, testCalculationIDs(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(intervals) != 3 || intervals[0].ValidTo != now.Add(2*time.Hour) || intervals[1].ValidFrom != now.Add(2*time.Hour) || intervals[1].ValidTo != now.Add(3*time.Hour) || intervals[2].ValidFrom != now.Add(3*time.Hour) {
		t.Fatalf("boundary intervals = %#v", intervals)
	}
	if !hasCalculationBoundary(boundaries, BoundaryAPIContract, now.Add(2*time.Hour)) || !hasCalculationBoundary(boundaries, BoundaryUnexplainedDecrease, now.Add(3*time.Hour)) {
		t.Fatalf("explanation boundaries = %#v", boundaries)
	}
}

func calculationTestSeries(start, end time.Time) CalculationSeries {
	return CalculationSeries{
		ServiceID: "service", LogicalAccountID: "account", UsageLimitSourceID: "source", LimitDefinitionID: "definition", CycleType: LimitCycleWeekly,
		Association:   CalculationPeriod{ID: "limit-link", ValidFrom: start, ValidTo: &end},
		Observations:  []CalculationObservation{{ID: "reset-start", ObservedAt: start, ResetAt: timePtr(start)}, {ID: "reset-end", ObservedAt: end, ResetAt: timePtr(end)}},
		PlanHistories: []PlanHistory{{ID: "history", LogicalAccountID: "account", PlanVersionID: "plan", ValidFrom: start, ValidTo: &end, CreatedAt: start, UpdatedAt: start}},
		CostSources:   []CalculationCostSource{{ID: "cost-source", AssociationPeriods: []CalculationPeriod{{ID: "cost-link", ValidFrom: start, ValidTo: &end}}, Completeness: []CalculationCompleteness{{ID: "complete", ValidFrom: start, ValidTo: &end, State: CompletenessConfirmed, LogicalAccountIDs: []string{"account"}}}}},
	}
}

func testCalculationIDs() func() string {
	index := 0
	return func() string {
		index++
		return "calculation-id-" + time.Duration(index).String()
	}
}

func timePtr(value time.Time) *time.Time { return &value }

func hasCalculationBoundary(boundaries []CalculationBoundary, kind CalculationBoundaryKind, at time.Time) bool {
	for _, boundary := range boundaries {
		if boundary.Kind == kind && boundary.At.Equal(at) {
			return true
		}
	}
	return false
}
