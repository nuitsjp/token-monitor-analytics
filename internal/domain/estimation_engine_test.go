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
	if result.Status != EstimationProvisional || len(result.Limits) != 1 || len(result.SeriesLimits) != 2 {
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
	if result.Status != EstimationProvisional || len(result.SeriesMultipliers) != 2 || result.SeriesMultipliers[0] != 1 || result.SeriesMultipliers[1] != 1 {
		t.Fatalf("result = %#v", result)
	}
}

func TestT032EstimateFromPointsClassifiesSevenStates(t *testing.T) {
	cases := []struct {
		name   string
		input  EstimationInput
		status EstimationStatus
	}{
		{name: "not applicable", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10), Intervals: []CalculationInterval{{State: CalculationExcluded, ExclusionReason: ExclusionCompletenessUnconfirmed}}}, status: EstimationNotApplicable},
		{name: "insufficient", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)[:1]}, status: EstimationInsufficient},
		{name: "unidentifiable", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.1}, 10, 20)}, status: EstimationUnidentifiable},
		{name: "provisional", input: EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)}, status: EstimationProvisional},
		{name: "verified", input: EstimationInput{Points: t032SingleThreePoints([]float64{0, 0.1, 0.2}, []float64{0, 10, 20})}, status: EstimationVerified},
		{name: "model mismatch", input: EstimationInput{Points: t032SingleThreePoints([]float64{0, 0.1, 0.2}, []float64{0, 10, 30})}, status: EstimationModelMismatch},
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
