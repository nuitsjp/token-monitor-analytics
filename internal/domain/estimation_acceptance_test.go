package domain

import (
	"testing"

	"gonum.org/v1/gonum/mat"
)

func TestACPhase1EstimationFixtures(t *testing.T) {
	t.Run("AC-P1-13 adjacent pairs only", func(t *testing.T) {
		points := t032SingleThreePoints([]float64{0.1, 0.3, 0.4}, []float64{10, 30, 40})
		rows := BuildAdjacentDifferenceRows(points)
		if len(rows) != 2 {
			t.Fatalf("difference rows = %d, want 2", len(rows))
		}
		if rows[0].StartPointID != points[0].ID || rows[0].EndPointID != points[1].ID || rows[1].StartPointID != points[1].ID || rows[1].EndPointID != points[2].ID {
			t.Fatalf("non-adjacent difference rows = %#v", rows)
		}
	})

	t.Run("AC-P1-14 two points estimate 100", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.3}, 10, 30)})
		if err != nil {
			t.Fatal(err)
		}
		assertEstimation(t, result, EstimationProvisional, 100, 0)
	})

	t.Run("AC-P1-15 three points verify 100 with zero error", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SingleThreePoints([]float64{0.1, 0.3, 0.4}, []float64{10, 30, 40})})
		if err != nil {
			t.Fatal(err)
		}
		assertEstimation(t, result, EstimationVerified, 100, 0)
	})

	t.Run("AC-P1-16 least squares 150 is model mismatch", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SingleThreePoints([]float64{0, 0.1, 0.2}, []float64{0, 10, 30})})
		if err != nil {
			t.Fatal(err)
		}
		assertEstimation(t, result, EstimationModelMismatch, 150, 1.0/3.0)
	})

	t.Run("AC-P1-17 rows and rank are separate failures", func(t *testing.T) {
		insufficient, err := EstimateFromDifferences(mat.NewDense(1, 2, []float64{0.1, 0.1}), []float64{20})
		if err != nil {
			t.Fatal(err)
		}
		if insufficient.Status != EstimationInsufficient || insufficient.Rows != 1 {
			t.Fatalf("insufficient result = %#v", insufficient)
		}
		rankDeficient, err := EstimateFromDifferences(mat.NewDense(2, 2, []float64{0.1, 0.1, 0.2, 0.2}), []float64{20, 40})
		if err != nil {
			t.Fatal(err)
		}
		if rankDeficient.Status != EstimationUnidentifiable || rankDeficient.Rank != 1 {
			t.Fatalf("rank-deficient result = %#v", rankDeficient)
		}
	})

	t.Run("AC-P1-18 multiplier five estimates baseline 100", func(t *testing.T) {
		multiplier := 5.0
		result, err := EstimateFromPoints(EstimationInput{
			Points: t032MixedPoints([]float64{0.1, 0.1}, []float64{0.2, 0.2}, 0, 60),
			PlanVersions: []EstimationPlanVersion{
				{ID: "plan-version-base", PlanID: "plan-base", IsBaseline: true},
				{ID: "plan-version-five", PlanID: "plan-five", LimitRules: []PlanLimitRule{{ID: "rule-five", PlanVersionID: "plan-version-five", LimitDefinitionID: "definition", Multiplier: &multiplier}}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		assertEstimation(t, result, EstimationProvisional, 100, 0)

		missing, err := EstimateFromPoints(EstimationInput{
			Points:       t032MixedPoints([]float64{0.1, 0.1}, []float64{0.2, 0.2}, 0, 60),
			PlanVersions: []EstimationPlanVersion{{ID: "plan-version-base", PlanID: "plan-base", IsBaseline: true}, {ID: "plan-version-five", PlanID: "plan-five"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if missing.Status != EstimationUncomputed || len(missing.Reasons) != 1 || missing.Reasons[0] != EstimationReasonMultiplierMissing {
			t.Fatalf("missing multiplier result = %#v", missing)
		}
	})

	t.Run("AC-P1-19 zero signal and unrounded threshold", func(t *testing.T) {
		zeroSignal, err := EstimateFromDifferences(mat.NewDense(1, 1, []float64{0.1}), []float64{0})
		if err != nil {
			t.Fatal(err)
		}
		if zeroSignal.Status != EstimationUnidentifiable {
			t.Fatalf("zero signal result = %#v", zeroSignal)
		}

		exactThreshold, err := EstimateFromDifferences(mat.NewDense(2, 1, []float64{0.1, 0.1}), []float64{9, 11})
		if err != nil {
			t.Fatal(err)
		}
		if exactThreshold.Status != EstimationVerified {
			t.Fatalf("exact 10%% result = %#v", exactThreshold)
		}
		aboveThreshold, err := EstimateFromDifferences(mat.NewDense(2, 1, []float64{0.1, 0.1}), []float64{8.999, 11.001})
		if err != nil {
			t.Fatal(err)
		}
		if aboveThreshold.Status != EstimationModelMismatch || aboveThreshold.AbsoluteErrorRatio <= 0.1 {
			t.Fatalf("unrounded threshold result = %#v", aboveThreshold)
		}
	})

	t.Run("P1-EST-18 zero total cost signal is unidentifiable", func(t *testing.T) {
		result, err := EstimateFromDifferences(mat.NewDense(1, 1, []float64{0.1}), []float64{0})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != EstimationUnidentifiable || len(result.Reasons) == 0 {
			t.Fatalf("zero signal result = %#v", result)
		}
	})
	t.Run("P1-EST-19 row and point shortages are distinguished", func(t *testing.T) {
		pointShortage, err := EstimateFromPoints(EstimationInput{Points: []EstimationPoint{{ID: "single", ServiceID: "service", LimitDefinitionID: "definition", CalculationIntervalID: "interval", ReferenceAt: t032SinglePoints([]float64{0.1}, []float64{0.2}, 0, 10)[0].ReferenceAt, LimitSeriesIDs: []string{"limit"}, Utilization: []float64{0.1}}}})
		if err != nil {
			t.Fatal(err)
		}
		if pointShortage.Status != EstimationInsufficient || len(pointShortage.Reasons) == 0 {
			t.Fatalf("point shortage result = %#v", pointShortage)
		}
		insufficient, err := EstimateFromDifferences(mat.NewDense(1, 2, []float64{0.1, 0.1}), []float64{20})
		if err != nil {
			t.Fatal(err)
		}
		if insufficient.Status != EstimationInsufficient || insufficient.Rows != 1 {
			t.Fatalf("insufficient result = %#v", insufficient)
		}
		rankDeficient, err := EstimateFromDifferences(mat.NewDense(2, 2, []float64{0.1, 0.1, 0.2, 0.2}), []float64{20, 40})
		if err != nil {
			t.Fatal(err)
		}
		if rankDeficient.Status != EstimationUnidentifiable || rankDeficient.Rank != 1 {
			t.Fatalf("rank deficient result = %#v", rankDeficient)
		}
	})
	t.Run("P1-EST-20 exactly identified positive solution is provisional", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SinglePoints([]float64{0.1}, []float64{0.3}, 10, 30)})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != EstimationProvisional || len(result.Limits) != 1 {
			t.Fatalf("provisional result = %#v", result)
		}
		closeEnough(t, result.Limits[0], 100)
	})
	t.Run("P1-EST-21 overidentified low-residual solution is verified", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SingleThreePoints([]float64{0.1, 0.3, 0.4}, []float64{10, 30, 40})})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != EstimationVerified || result.AbsoluteErrorRatio > 0.1 {
			t.Fatalf("verified result = %#v", result)
		}
	})
	t.Run("P1-EST-22 overidentified high-residual solution is model mismatch", func(t *testing.T) {
		result, err := EstimateFromPoints(EstimationInput{Points: t032SingleThreePoints([]float64{0, 0.1, 0.2}, []float64{0, 10, 30})})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != EstimationModelMismatch || result.AbsoluteErrorRatio <= 0.1 {
			t.Fatalf("model mismatch result = %#v", result)
		}
	})
}

func assertEstimation(t *testing.T, result EstimationResult, status EstimationStatus, limit, errorRatio float64) {
	t.Helper()
	if result.Status != status || len(result.Limits) != 1 {
		t.Fatalf("estimation result = %#v, want status %s", result, status)
	}
	closeEnough(t, result.Limits[0], limit)
	closeEnough(t, result.AbsoluteErrorRatio, errorRatio)
}
