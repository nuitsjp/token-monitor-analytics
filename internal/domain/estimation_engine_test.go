package domain

import (
	"testing"
	"time"

	"gonum.org/v1/gonum/mat"
)

func TestT032EstimateFromPointsAppliesPlanMultiplierAndTracesSeries(t *testing.T) {
	points := t032MixedPoints([]float64{0.1, 0.1}, []float64{0.2, 0.2}, 0, 60)
	multiplier := 5.0
	result, err := EstimateFromPoints(EstimationInput{
		Points: points,
		PlanVersions: []EstimationPlanVersion{
			{ID: "plan-version-base", PlanID: "plan-base", IsBaseline: true},
			{ID: "plan-version-five", PlanID: "plan-five", LimitRules: []PlanLimitRule{{ID: "rule-five", PlanVersionID: "plan-version-five", LimitDefinitionID: "definition", Multiplier: &multiplier}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationEstimated || len(result.Limits) != 1 || len(result.SeriesLimits) != 2 {
		t.Fatalf("result = %#v", result)
	}
	closeEnough(t, result.Limits[0], 100)
	closeEnough(t, result.SeriesLimits[0], 100)
	closeEnough(t, result.SeriesLimits[1], 500)
	if len(result.PlanLimitRuleIDs) != 1 || result.PlanLimitRuleIDs[0] != "rule-five" || result.CalculationLogicVersion != CalculationLogicVersion {
		t.Fatalf("trace = %#v", result)
	}
	if len(result.LimitSeriesLogicalAccountIDs) != 2 || len(result.LimitSeriesCalculationIntervalIDs) != 2 || len(result.SeriesMultipliers) != 2 {
		t.Fatalf("series trace = %#v", result)
	}
	t.Run("P1-EST-07 all non-baseline plan versions require explicit multipliers", func(t *testing.T) {
		if len(result.SeriesMultipliers) != 2 || result.SeriesMultipliers[0] != 1 || result.SeriesMultipliers[1] != multiplier || len(result.PlanLimitRuleIDs) != 1 {
			t.Fatalf("plan multiplier trace = %#v", result)
		}
	})
}

func TestT032MissingPlanMultiplierIsUncomputed(t *testing.T) {
	points := t032MixedPoints([]float64{0.1, 0.1}, []float64{0.2, 0.2}, 0, 60)
	result, err := EstimateFromPoints(EstimationInput{Points: points, PlanVersions: []EstimationPlanVersion{{ID: "plan-version-base", PlanID: "plan-base", IsBaseline: true}, {ID: "plan-version-five", PlanID: "plan-five"}}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationUncomputed || len(result.Reasons) != 1 || result.Reasons[0] != EstimationReasonMultiplierMissing {
		t.Fatalf("result = %#v", result)
	}
	t.Run("P1-EST-08 missing official multiplier is not inferred", func(t *testing.T) {
		if result.Status != EstimationUncomputed || len(result.Reasons) != 1 || result.Reasons[0] != EstimationReasonMultiplierMissing {
			t.Fatalf("missing multiplier result = %#v", result)
		}
	})
}

func TestT032BaselinePlanIDAllowsMultipleVersions(t *testing.T) {
	points := t032SamePlanVersionsPoints()
	result, err := EstimateFromPoints(EstimationInput{
		Points: points,
		PlanVersions: []EstimationPlanVersion{
			{ID: "plan-version-base-old", PlanID: "plan-base", IsBaseline: true},
			{ID: "plan-version-base-new", PlanID: "plan-base", IsBaseline: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationEstimated || len(result.SeriesMultipliers) != 2 || result.SeriesMultipliers[0] != 1 || result.SeriesMultipliers[1] != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestT032EstimateFromPointsClassifiesSixStates(t *testing.T) {
	cases := []struct {
		name   string
		input  EstimationInput
		status EstimationStatus
	}{
		{name: "not applicable", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10), Intervals: []CalculationInterval{{State: CalculationExcluded, ExclusionReason: ExclusionCompletenessUnconfirmed}}}, status: EstimationNotApplicable},
		{name: "insufficient", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)[:1]}, status: EstimationInsufficient},
		{name: "unidentifiable", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.1}, 10, 20)}, status: EstimationUnidentifiable},
		{name: "estimated 2 points", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)}, status: EstimationEstimated},
		{name: "estimated 3 points", input: EstimationInput{Points: t032SingleThreePoints([]float64{0, 0.1, 0.2}, []float64{0, 10, 20})}, status: EstimationEstimated},
		{name: "uncomputed", input: EstimationInput{Points: func() []EstimationPoint {
			points := t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)
			points[1].CalculationLogicVersion = "old"
			return points
		}()}, status: EstimationUncomputed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result, err := EstimateFromPoints(testCase.input)
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != testCase.status || len(result.Reasons) == 0 {
				t.Fatalf("result = %#v, want %s", result, testCase.status)
			}
		})
	}
	t.Run("P1-EST-24 every estimation state carries a reason", func(t *testing.T) {
		for _, testCase := range cases {
			result, err := EstimateFromPoints(testCase.input)
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != testCase.status || len(result.Reasons) == 0 {
				t.Fatalf("state %s = %#v", testCase.name, result)
			}
		}
	})
}

func TestT032EstimateFromPointsRejectsMixedInterval(t *testing.T) {
	points := t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)
	points[1].CalculationIntervalID = "other-interval"
	points[1].CalculationIntervalIDs = []string{"other-interval"}
	result, err := EstimateFromPoints(EstimationInput{Points: points})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationUncomputed || len(result.Reasons) != 1 || result.Reasons[0] != EstimationReasonMixedInterval {
		t.Fatalf("result = %#v", result)
	}
	t.Run("P1-EST-03 mixed calculation intervals are not combined", func(t *testing.T) {
		if result.Status != EstimationUncomputed || len(result.Reasons) != 1 || result.Reasons[0] != EstimationReasonMixedInterval {
			t.Fatalf("mixed interval result = %#v", result)
		}
		cases := []struct {
			name   string
			mutate func(*EstimationPoint)
			reason string
		}{
			{name: "definition", mutate: func(point *EstimationPoint) { point.LimitDefinitionID = "other-definition" }, reason: EstimationReasonMixedDefinition},
			{name: "cycle", mutate: func(point *EstimationPoint) { point.CycleType = LimitCycleBilling }, reason: EstimationReasonMixedCycle},
			{name: "logic", mutate: func(point *EstimationPoint) { point.CalculationLogicVersion = "old-logic" }, reason: EstimationReasonMixedLogic},
			{name: "target", mutate: func(point *EstimationPoint) { point.LimitSeriesIDs = []string{"other-series"} }, reason: EstimationReasonTargetMismatch},
		}
		for _, testCase := range cases {
			points := t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)
			testCase.mutate(&points[1])
			got, err := EstimateFromPoints(EstimationInput{Points: points})
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != EstimationUncomputed || len(got.Reasons) != 1 || got.Reasons[0] != testCase.reason {
				t.Fatalf("mixed %s result = %#v", testCase.name, got)
			}
		}
	})
}

func TestT032AdjacentDifferencesDropsNegativeAndAllZeroRows(t *testing.T) {
	points := []EstimationPoint{
		t032Point(time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC), []float64{0.1}, 10),
		t032Point(time.Date(2026, 8, 25, 1, 0, 0, 0, time.UTC), []float64{0.1}, 10),
		t032Point(time.Date(2026, 8, 25, 2, 0, 0, 0, time.UTC), []float64{0.05}, 5),
	}
	coefficients, costs, err := AdjacentDifferences(points)
	if err != nil {
		t.Fatal(err)
	}
	if coefficients != nil || len(costs) != 0 {
		t.Fatalf("filtered differences = coefficients %#v costs %#v", coefficients, costs)
	}
	t.Run("P1-EST-09 negative cost and utilization deltas are excluded", func(t *testing.T) {
		if coefficients != nil || len(costs) != 0 {
			t.Fatalf("negative deltas were corrected or used: coefficients %#v costs %#v", coefficients, costs)
		}
	})
}

func TestT032LowLevelUnidentifiableReason(t *testing.T) {
	result, err := EstimateFromDifferences(mat.NewDense(2, 2, []float64{0.1, 0.2, 0.2, 0.4}), []float64{10, 20})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationUnidentifiable || len(result.Reasons) == 0 {
		t.Fatalf("result = %#v", result)
	}
}

func t032SinglePoints(first, second []float64, firstCost, secondCost float64) []EstimationPoint {
	return []EstimationPoint{t032PointAt(time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC), first, firstCost, "limit-base", "account", "plan-version-base", "interval"), t032PointAt(time.Date(2026, 8, 25, 1, 0, 0, 0, time.UTC), second, secondCost, "limit-base", "account", "plan-version-base", "interval")}
}

func t032SingleThreePoints(utilization []float64, costs []float64) []EstimationPoint {
	points := make([]EstimationPoint, len(utilization))
	for index := range points {
		points[index] = t032PointAt(time.Date(2026, 8, 25, index, 0, 0, 0, time.UTC), []float64{utilization[index]}, costs[index], "limit-base", "account", "plan-version-base", "interval")
	}
	return points
}

func t032MixedPoints(first, second []float64, firstCost, secondCost float64) []EstimationPoint {
	return []EstimationPoint{t032MixedPointAt(time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC), first, firstCost), t032MixedPointAt(time.Date(2026, 8, 25, 1, 0, 0, 0, time.UTC), second, secondCost)}
}

func t032SamePlanVersionsPoints() []EstimationPoint {
	points := t032MixedPoints([]float64{0.1, 0.1}, []float64{0.2, 0.2}, 0, 10)
	for index := range points {
		points[index].LimitSeriesPlanVersionIDs = []string{"plan-version-base-old", "plan-version-base-new"}
	}
	return points
}

func t032MixedPointAt(at time.Time, utilization []float64, cost float64) EstimationPoint {
	return t032PointAt(at, utilization, cost, "limit-base", "account-base", "plan-version-base", "interval", "limit-five", "account-five", "plan-version-five")
}

func t032Point(at time.Time, utilization []float64, cost float64) EstimationPoint {
	return t032PointAt(at, utilization, cost, "limit-base", "account", "plan-version-base", "interval")
}

func t032PointAt(at time.Time, utilization []float64, cost float64, firstID, firstAccount, firstPlan, firstInterval string, rest ...string) EstimationPoint {
	seriesIDs := []string{firstID}
	accounts := []string{firstAccount}
	plans := []string{firstPlan}
	intervals := []string{firstInterval}
	for index := 0; index+3 <= len(rest); index += 3 {
		seriesIDs = append(seriesIDs, rest[index])
		accounts = append(accounts, rest[index+1])
		plans = append(plans, rest[index+2])
		intervals = append(intervals, firstInterval)
	}
	return EstimationPoint{ID: "point-" + at.Format("15"), ServiceID: "service", LimitDefinitionID: "definition", CycleType: LimitCycleWeekly, CalculationIntervalID: firstInterval, CalculationIntervalIDs: []string{firstInterval}, ReferenceAt: at, SharedCost: cost, Utilization: utilization, LimitSeriesIDs: seriesIDs, LimitSeriesLogicalAccountIDs: accounts, LimitSeriesPlanVersionIDs: plans, LimitSeriesCalculationIntervalIDs: intervals, CostSourceIDs: []string{"cost"}, CalculationLogicVersion: CalculationLogicVersion, MatchingRuleVersion: MatchingRuleVersion, CreatedAt: at, UpdatedAt: at}
}
