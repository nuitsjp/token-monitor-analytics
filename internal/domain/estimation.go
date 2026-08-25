package domain

import (
	"errors"
	"fmt"
	"math"

	"gonum.org/v1/gonum/mat"
)

const (
	CalculationLogicVersion = "nnls-lawson-hanson-v1"
	RankToleranceFactor     = 1e-10
	NnlsTolerance           = 1e-12
	NnlsIterationLimit      = 10_000
)

type EstimationStatus string

const (
	EstimationInsufficient   EstimationStatus = "insufficient_observations"
	EstimationUnidentifiable EstimationStatus = "unidentifiable"
	EstimationProvisional    EstimationStatus = "provisional"
	EstimationVerified       EstimationStatus = "verified"
	EstimationModelMismatch  EstimationStatus = "model_mismatch"
)

type EstimationPoint struct {
	SharedCost  float64
	Utilization []float64
}

type EstimationResult struct {
	Status             EstimationStatus
	Limits             []float64
	Rows               int
	Rank               int
	AbsoluteErrorRatio float64
}

func AdjacentDifferences(points []EstimationPoint) (*mat.Dense, []float64, error) {
	if len(points) < 2 {
		return nil, nil, fmt.Errorf("at least two estimation points are required")
	}
	columns := len(points[0].Utilization)
	if columns == 0 {
		return nil, nil, fmt.Errorf("at least one unknown is required")
	}
	data := make([]float64, (len(points)-1)*columns)
	costs := make([]float64, len(points)-1)
	for row := 1; row < len(points); row++ {
		if len(points[row].Utilization) != columns {
			return nil, nil, fmt.Errorf("point %d has %d utilization values, want %d", row, len(points[row].Utilization), columns)
		}
		costs[row-1] = points[row].SharedCost - points[row-1].SharedCost
		for column := range columns {
			data[(row-1)*columns+column] = points[row].Utilization[column] - points[row-1].Utilization[column]
		}
	}
	return mat.NewDense(len(points)-1, columns, data), costs, nil
}

func EstimateFromDifferences(coefficients *mat.Dense, costs []float64) (EstimationResult, error) {
	rows, columns := coefficients.Dims()
	if rows != len(costs) {
		return EstimationResult{}, fmt.Errorf("coefficient rows %d do not match costs %d", rows, len(costs))
	}
	if rows == 0 || columns == 0 {
		return EstimationResult{}, fmt.Errorf("coefficient matrix must not be empty")
	}
	if !finiteMatrix(coefficients) || !finiteSlice(costs) {
		return EstimationResult{}, fmt.Errorf("estimation input must contain only finite numbers")
	}

	rank, err := normalizedRank(coefficients)
	if err != nil {
		return EstimationResult{}, err
	}
	result := EstimationResult{Rows: rows, Rank: rank}
	if rows < columns {
		result.Status = EstimationInsufficient
		return result, nil
	}
	if sum(costs) == 0 || rank < columns {
		result.Status = EstimationUnidentifiable
		return result, nil
	}

	limits, err := solveNNLS(coefficients, costs)
	if err != nil {
		return EstimationResult{}, err
	}
	result.Limits = limits
	for _, value := range limits {
		if !isFinite(value) || value <= NnlsTolerance {
			result.Status = EstimationModelMismatch
			return result, nil
		}
	}

	predicted := make([]float64, rows)
	for row := range rows {
		for column, limit := range limits {
			predicted[row] += coefficients.At(row, column) * limit
		}
	}
	denominator := sum(costs)
	for row, value := range costs {
		result.AbsoluteErrorRatio += math.Abs(value - predicted[row])
	}
	result.AbsoluteErrorRatio /= denominator
	if rows == columns {
		result.Status = EstimationProvisional
	} else if result.AbsoluteErrorRatio <= 0.1 {
		result.Status = EstimationVerified
	} else {
		result.Status = EstimationModelMismatch
	}
	return result, nil
}

func normalizedRank(coefficients *mat.Dense) (int, error) {
	rows, columns := coefficients.Dims()
	normalized := mat.NewDense(rows, columns, nil)
	for column := range columns {
		var normSquared float64
		for row := range rows {
			value := coefficients.At(row, column)
			normSquared += value * value
		}
		norm := math.Sqrt(normSquared)
		if norm == 0 {
			continue
		}
		for row := range rows {
			normalized.Set(row, column, coefficients.At(row, column)/norm)
		}
	}
	var decomposition mat.SVD
	if !decomposition.Factorize(normalized, mat.SVDNone) {
		return 0, fmt.Errorf("factorize normalized coefficient matrix")
	}
	values := decomposition.Values(nil)
	if len(values) == 0 || values[0] == 0 {
		return 0, nil
	}
	threshold := RankToleranceFactor * float64(max(rows, columns)) * values[0]
	var rank int
	for _, value := range values {
		if value > threshold {
			rank++
		}
	}
	return rank, nil
}

func solveNNLS(coefficients *mat.Dense, costs []float64) ([]float64, error) {
	_, columns := coefficients.Dims()
	x := make([]float64, columns)
	passive := make([]bool, columns)
	for iteration := 0; iteration < NnlsIterationLimit; iteration++ {
		w := dual(coefficients, costs, x)
		entering := -1
		for column, value := range w {
			if !passive[column] && value > NnlsTolerance && (entering < 0 || value > w[entering]) {
				entering = column
			}
		}
		if entering < 0 {
			if err := verifyKKT(coefficients, costs, x); err != nil {
				return nil, err
			}
			return x, nil
		}
		passive[entering] = true

		for {
			z, err := passiveLeastSquares(coefficients, costs, passive)
			if err != nil {
				return nil, err
			}
			allPositive := true
			for column, value := range z {
				if passive[column] && value <= NnlsTolerance {
					allPositive = false
					break
				}
			}
			if allPositive {
				x = z
				break
			}

			alpha := math.Inf(1)
			for column, value := range z {
				if passive[column] && value <= NnlsTolerance {
					candidate := x[column] / (x[column] - value)
					if candidate < alpha {
						alpha = candidate
					}
				}
			}
			if math.IsInf(alpha, 1) {
				return nil, errors.New("NNLS active set made no progress")
			}
			for column := range columns {
				x[column] += alpha * (z[column] - x[column])
				if passive[column] && x[column] <= NnlsTolerance {
					x[column] = 0
					passive[column] = false
				}
			}
		}
	}
	return nil, fmt.Errorf("NNLS exceeded %d iterations", NnlsIterationLimit)
}

func passiveLeastSquares(coefficients *mat.Dense, costs []float64, passive []bool) ([]float64, error) {
	rows, columns := coefficients.Dims()
	indices := make([]int, 0, columns)
	for column, enabled := range passive {
		if enabled {
			indices = append(indices, column)
		}
	}
	if len(indices) == 0 {
		return make([]float64, columns), nil
	}
	subset := mat.NewDense(rows, len(indices), nil)
	for row := range rows {
		for subsetColumn, originalColumn := range indices {
			subset.Set(row, subsetColumn, coefficients.At(row, originalColumn))
		}
	}
	var decomposition mat.SVD
	if !decomposition.Factorize(subset, mat.SVDFull) {
		return nil, fmt.Errorf("factorize NNLS passive matrix")
	}
	values := decomposition.Values(nil)
	threshold := NnlsTolerance * values[0]
	var rank int
	for _, value := range values {
		if value > threshold {
			rank++
		}
	}
	if rank == 0 {
		return nil, fmt.Errorf("NNLS passive matrix has zero rank")
	}
	var solution mat.Dense
	decomposition.SolveTo(&solution, mat.NewDense(rows, 1, append([]float64(nil), costs...)), rank)
	result := make([]float64, columns)
	for subsetColumn, originalColumn := range indices {
		result[originalColumn] = solution.At(subsetColumn, 0)
	}
	return result, nil
}

func dual(coefficients *mat.Dense, costs, x []float64) []float64 {
	rows, columns := coefficients.Dims()
	result := make([]float64, columns)
	for row := range rows {
		residual := costs[row]
		for column := range columns {
			residual -= coefficients.At(row, column) * x[column]
		}
		for column := range columns {
			result[column] += coefficients.At(row, column) * residual
		}
	}
	return result
}

func verifyKKT(coefficients *mat.Dense, costs, x []float64) error {
	w := dual(coefficients, costs, x)
	for column, value := range w {
		if x[column] > NnlsTolerance && math.Abs(value) > 1e-9 {
			return fmt.Errorf("NNLS KKT stationarity failed at column %d: %g", column, value)
		}
		if x[column] <= NnlsTolerance && value > 1e-9 {
			return fmt.Errorf("NNLS KKT dual feasibility failed at column %d: %g", column, value)
		}
	}
	return nil
}

func finiteMatrix(matrix *mat.Dense) bool {
	rows, columns := matrix.Dims()
	for row := range rows {
		for column := range columns {
			if !isFinite(matrix.At(row, column)) {
				return false
			}
		}
	}
	return true
}

func finiteSlice(values []float64) bool {
	for _, value := range values {
		if !isFinite(value) {
			return false
		}
	}
	return true
}

func isFinite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func sum(values []float64) float64 {
	var result float64
	for _, value := range values {
		result += value
	}
	return result
}
