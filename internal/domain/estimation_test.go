package domain

import (
	"math"
	"testing"

	"gonum.org/v1/gonum/mat"
)

func TestACP113AdjacentDifferences(t *testing.T) {
	points := []EstimationPoint{
		{SharedCost: 1, Utilization: []float64{0.1}},
		{SharedCost: 3, Utilization: []float64{0.2}},
		{SharedCost: 6, Utilization: []float64{0.4}},
	}
	coefficients, costs, err := AdjacentDifferences(points)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := coefficients.Dims()
	if rows != 2 || len(costs) != 2 {
		t.Fatalf("rows = %d, costs = %d, want two adjacent rows", rows, len(costs))
	}
	closeEnough(t, costs[0], 2)
	closeEnough(t, costs[1], 3)
	t.Run("P1-EST-10 adjacent differences keep informative zero terms", func(t *testing.T) {
		coefficients, costs, err := AdjacentDifferences([]EstimationPoint{{SharedCost: 0, Utilization: []float64{0}}, {SharedCost: 0, Utilization: []float64{0.1}}})
		if err != nil {
			t.Fatal(err)
		}
		rows, _ := coefficients.Dims()
		if rows != 1 || len(costs) != 1 || costs[0] != 0 || coefficients.At(0, 0) != 0.1 {
			t.Fatalf("informative zero row = rows %d costs %#v coefficients %#v", rows, costs, coefficients)
		}
	})
}

func TestACP114ProvisionalSingleAccount(t *testing.T) {
	result := estimatePoints(t, []EstimationPoint{
		{SharedCost: 10, Utilization: []float64{0.1}},
		{SharedCost: 30, Utilization: []float64{0.3}},
	})
	if result.Status != EstimationProvisional {
		t.Fatalf("status = %s", result.Status)
	}
	closeEnough(t, result.Limits[0], 100)
}

func TestACP115VerifiedSingleAccount(t *testing.T) {
	result := estimatePoints(t, []EstimationPoint{
		{SharedCost: 10, Utilization: []float64{0.1}},
		{SharedCost: 30, Utilization: []float64{0.3}},
		{SharedCost: 40, Utilization: []float64{0.4}},
	})
	if result.Status != EstimationVerified {
		t.Fatalf("status = %s", result.Status)
	}
	closeEnough(t, result.Limits[0], 100)
	closeEnough(t, result.AbsoluteErrorRatio, 0)
}

func TestACP116ModelMismatch(t *testing.T) {
	result := estimatePoints(t, []EstimationPoint{
		{SharedCost: 0, Utilization: []float64{0}},
		{SharedCost: 10, Utilization: []float64{0.1}},
		{SharedCost: 30, Utilization: []float64{0.2}},
	})
	if result.Status != EstimationModelMismatch {
		t.Fatalf("status = %s", result.Status)
	}
	closeEnough(t, result.Limits[0], 150)
	closeEnough(t, result.AbsoluteErrorRatio, 1.0/3.0)
	t.Run("P1-EST-11 model mismatch retains the unmodified residual", func(t *testing.T) {
		if result.Status != EstimationModelMismatch || result.AbsoluteErrorRatio != 1.0/3.0 {
			t.Fatalf("model mismatch was not retained: %#v", result)
		}
	})
}

func TestACP117InsufficientAndRankDeficient(t *testing.T) {
	insufficient, err := EstimateFromDifferences(mat.NewDense(1, 2, []float64{0.1, 0.2}), []float64{10})
	if err != nil {
		t.Fatal(err)
	}
	if insufficient.Status != EstimationInsufficient {
		t.Fatalf("insufficient status = %s", insufficient.Status)
	}
	rankDeficient, err := EstimateFromDifferences(mat.NewDense(2, 2, []float64{0.1, 0.2, 0.2, 0.4}), []float64{10, 20})
	if err != nil {
		t.Fatal(err)
	}
	if rankDeficient.Status != EstimationUnidentifiable {
		t.Fatalf("rank deficient status = %s", rankDeficient.Status)
	}
	t.Run("P1-EST-14 rank below effective unknown count is unidentifiable", func(t *testing.T) {
		if rankDeficient.Rank != 1 || rankDeficient.Status != EstimationUnidentifiable {
			t.Fatalf("rank result = %#v", rankDeficient)
		}
	})
}

func TestACP118PlanMultiplier(t *testing.T) {
	result, err := EstimateFromDifferences(mat.NewDense(1, 1, []float64{0.1 + 5*0.1}), []float64{60})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != EstimationProvisional {
		t.Fatalf("status = %s", result.Status)
	}
	closeEnough(t, result.Limits[0], 100)
}

func TestACP119ZeroSignalAndUnroundedThreshold(t *testing.T) {
	zeroSignal, err := EstimateFromDifferences(mat.NewDense(1, 1, []float64{0.1}), []float64{0})
	if err != nil {
		t.Fatal(err)
	}
	if zeroSignal.Status != EstimationUnidentifiable {
		t.Fatalf("zero signal status = %s", zeroSignal.Status)
	}

	below, err := EstimateFromDifferences(mat.NewDense(2, 1, []float64{1, 1}), []float64{100, 81.8181818183})
	if err != nil {
		t.Fatal(err)
	}
	if below.AbsoluteErrorRatio > 0.1 || below.Status != EstimationVerified {
		t.Fatalf("below threshold: status=%s ratio=%.15f", below.Status, below.AbsoluteErrorRatio)
	}
	above, err := EstimateFromDifferences(mat.NewDense(2, 1, []float64{1, 1}), []float64{100, 81.8181818180})
	if err != nil {
		t.Fatal(err)
	}
	if above.AbsoluteErrorRatio <= 0.1 || above.Status != EstimationModelMismatch {
		t.Fatalf("above threshold: status=%s ratio=%.15f", above.Status, above.AbsoluteErrorRatio)
	}
	t.Run("P1-EST-16 threshold compares unrounded residual", func(t *testing.T) {
		if below.Status != EstimationVerified || above.Status != EstimationModelMismatch || above.AbsoluteErrorRatio <= 0.1 {
			t.Fatalf("unrounded threshold results: below=%#v above=%#v", below, above)
		}
	})
}

func TestNNLSIsInvariantToRowOrder(t *testing.T) {
	first, err := EstimateFromDifferences(mat.NewDense(3, 2, []float64{1, 0, 0, 1, 1, 1}), []float64{2, 3, 5})
	if err != nil {
		t.Fatal(err)
	}
	second, err := EstimateFromDifferences(mat.NewDense(3, 2, []float64{1, 1, 1, 0, 0, 1}), []float64{5, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	for index := range first.Limits {
		closeEnough(t, first.Limits[index], second.Limits[index])
	}
	t.Run("P1-EST-13 normalized rank ignores zero columns", func(t *testing.T) {
		rank, err := normalizedRank(mat.NewDense(2, 2, []float64{1, 0, 0, 0}))
		if err != nil {
			t.Fatal(err)
		}
		if rank != 1 {
			t.Fatalf("normalized rank = %d, want 1", rank)
		}
	})
	t.Run("P1-EST-15 NNLS rejects non-positive reported limits", func(t *testing.T) {
		result, err := EstimateFromDifferences(mat.NewDense(1, 1, []float64{1}), []float64{-1})
		if err != nil {
			t.Fatal(err)
		}
		if result.Status != EstimationModelMismatch || len(result.Limits) != 1 || result.Limits[0] > NnlsTolerance {
			t.Fatalf("non-positive solution result = %#v", result)
		}
	})
}

func estimatePoints(t *testing.T, points []EstimationPoint) EstimationResult {
	t.Helper()
	coefficients, costs, err := AdjacentDifferences(points)
	if err != nil {
		t.Fatal(err)
	}
	result, err := EstimateFromDifferences(coefficients, costs)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func closeEnough(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9*math.Max(1, math.Abs(want)) {
		t.Fatalf("got %.15g, want %.15g", got, want)
	}
}
