package domain

import (
	"errors"
	"math"
	"sort"
	"strings"

	"gonum.org/v1/gonum/mat"
)

const (
	EstimationReasonInsufficientPoints = "insufficient_points"
	EstimationReasonInsufficientRows   = "insufficient_differences"
	EstimationReasonMultiplierMissing  = "multiplier_missing"
	EstimationReasonMixedInterval      = "mixed_calculation_interval"
	EstimationReasonMixedDefinition    = "mixed_limit_definition"
	EstimationReasonMixedCycle         = "mixed_cycle"
	EstimationReasonMixedLogic         = "mixed_calculation_logic"
	EstimationReasonTargetMismatch     = "target_set_mismatch"
	EstimationReasonNoValidDifferences = "no_valid_differences"
)

type EstimationPlanVersion struct {
	ID         string
	PlanID     string
	IsBaseline bool
	LimitRules []PlanLimitRule
}

type EstimationInput struct {
	Points       []EstimationPoint
	Intervals    []CalculationInterval
	PlanVersions []EstimationPlanVersion
}

func EstimateFromPoints(input EstimationInput) (EstimationResult, error) {
	result := estimationTrace(input.Points)
	result.DifferenceRows = BuildAdjacentDifferenceRows(input.Points)
	if len(input.Intervals) > 0 {
		for _, interval := range input.Intervals {
			if interval.State == CalculationExcluded {
				reason := strings.TrimSpace(string(interval.ExclusionReason))
				if reason == "" {
					reason = "excluded"
				}
				result.Status = EstimationNotApplicable
				result.Reasons = []string{reason}
				return result, nil
			}
		}
	}
	if len(input.Points) < 2 {
		result.Status = EstimationInsufficient
		result.Reasons = []string{EstimationReasonInsufficientPoints}
		return result, nil
	}

	points := append([]EstimationPoint(nil), input.Points...)
	sort.SliceStable(points, func(a, b int) bool {
		if points[a].ReferenceAt.Equal(points[b].ReferenceAt) {
			return points[a].ID < points[b].ID
		}
		return points[a].ReferenceAt.Before(points[b].ReferenceAt)
	})
	if reason := validatePointSet(points); reason != "" {
		result.Status = EstimationUncomputed
		result.Reasons = []string{reason}
		return result, nil
	}
	seriesCount := len(points[0].LimitSeriesIDs)
	multipliers, ruleIDs, err := estimationMultipliers(points[0], input.PlanVersions)
	if err != nil {
		return markMultiplierMissing(result)
	}
	coefficients, costs, err := AdjacentDifferences(points)
	if err != nil {
		return EstimationResult{}, err
	}
	if coefficients == nil {
		result.Status = EstimationInsufficient
		result.Reasons = []string{EstimationReasonNoValidDifferences}
		return result, nil
	}
	rows, _ := coefficients.Dims()
	effective := make([]float64, rows)
	for row := 0; row < rows; row++ {
		for seriesIndex := 0; seriesIndex < seriesCount; seriesIndex++ {
			effective[row] += coefficients.At(row, seriesIndex) * multipliers[seriesIndex]
		}
	}
	result, err = EstimateFromDifferences(mat.NewDense(rows, 1, effective), costs)
	if err != nil {
		return EstimationResult{}, err
	}
	traced := estimationTrace(input.Points)
	result.PointIDs = traced.PointIDs
	result.DifferenceRows = BuildAdjacentDifferenceRows(points)
	result.ObservationIDs = traced.ObservationIDs
	result.AssociationIDs = traced.AssociationIDs
	result.CompletenessIDs = traced.CompletenessIDs
	result.NormalizationGenerations = traced.NormalizationGenerations
	result.NormalizationRuleVersions = traced.NormalizationRuleVersions
	result.NormalizationLogicVersions = traced.NormalizationLogicVersions
	result.LimitSeriesIDs = append([]string(nil), points[0].LimitSeriesIDs...)
	result.LimitSeriesLogicalAccountIDs = append([]string(nil), points[0].LimitSeriesLogicalAccountIDs...)
	result.LimitSeriesCalculationIntervalIDs = append([]string(nil), points[0].LimitSeriesCalculationIntervalIDs...)
	result.LimitSeriesPlanVersionIDs = append([]string(nil), points[0].LimitSeriesPlanVersionIDs...)
	result.SeriesMultipliers = append([]float64(nil), multipliers...)
	result.PlanLimitRuleIDs = uniqueStrings(ruleIDs)
	result.SeriesPlanLimitRuleIDs = make([][]string, len(points[0].LimitSeriesPlanVersionIDs))
	seriesPlanIDs := make(map[string]struct{}, len(points[0].LimitSeriesPlanVersionIDs))
	for _, planVersionID := range points[0].LimitSeriesPlanVersionIDs {
		seriesPlanIDs[planVersionID] = struct{}{}
	}
	for _, plan := range input.PlanVersions {
		if _, ok := seriesPlanIDs[plan.ID]; !ok {
			continue
		}
		for _, rule := range plan.LimitRules {
			if rule.LimitDefinitionID != points[0].LimitDefinitionID {
				continue
			}
			result.PlanLimitRules = append(result.PlanLimitRules, rule)
			for index, planVersionID := range points[0].LimitSeriesPlanVersionIDs {
				if planVersionID == rule.PlanVersionID {
					result.SeriesPlanLimitRuleIDs[index] = append(result.SeriesPlanLimitRuleIDs[index], rule.ID)
				}
			}
		}
	}
	sort.Slice(result.PlanLimitRules, func(i, j int) bool { return result.PlanLimitRules[i].ID < result.PlanLimitRules[j].ID })
	if len(result.Limits) == 1 {
		result.SeriesLimits = make([]float64, len(multipliers))
		for index, multiplier := range multipliers {
			result.SeriesLimits[index] = result.Limits[0] * multiplier
		}
	}
	return result, nil
}

func markMultiplierMissing(result EstimationResult) (EstimationResult, error) {
	result.Status = EstimationUncomputed
	result.Reasons = []string{EstimationReasonMultiplierMissing}
	return result, nil
}

func estimationMultipliers(point EstimationPoint, plans []EstimationPlanVersion) ([]float64, []string, error) {
	planIDs := uniqueStrings(point.LimitSeriesPlanVersionIDs)
	multipliers := make([]float64, len(point.LimitSeriesPlanVersionIDs))
	for index := range multipliers {
		multipliers[index] = 1
	}
	if len(planIDs) <= 1 {
		return multipliers, nil, nil
	}
	planByID := make(map[string]EstimationPlanVersion, len(plans))
	for _, plan := range plans {
		if strings.TrimSpace(plan.ID) == "" {
			return nil, nil, errors.New("plan version ID is required")
		}
		if _, exists := planByID[plan.ID]; exists {
			return nil, nil, errors.New("plan version is duplicated")
		}
		planByID[plan.ID] = plan
	}
	baselinePlanID := ""
	for _, planID := range planIDs {
		plan, ok := planByID[planID]
		if !ok {
			return nil, nil, errors.New("plan version is missing")
		}
		if plan.IsBaseline {
			if strings.TrimSpace(plan.PlanID) == "" {
				return nil, nil, errors.New("baseline plan ID is missing")
			}
			if baselinePlanID != "" && baselinePlanID != plan.PlanID {
				return nil, nil, errors.New("multiple baseline plans")
			}
			baselinePlanID = plan.PlanID
		}
	}
	if baselinePlanID == "" {
		return nil, nil, errors.New("baseline plan is missing")
	}
	ruleIDs := make([]string, 0)
	for index, planID := range point.LimitSeriesPlanVersionIDs {
		plan, ok := planByID[planID]
		if !ok {
			return nil, nil, errors.New("plan version is missing")
		}
		multiplier := 1.0
		if !plan.IsBaseline {
			if plan.PlanID == baselinePlanID {
				multipliers[index] = 1
				continue
			}
			multiplier = 0
			for _, rule := range plan.LimitRules {
				if rule.PlanVersionID != plan.ID || rule.LimitDefinitionID != point.LimitDefinitionID {
					continue
				}
				if rule.Multiplier == nil || math.IsNaN(*rule.Multiplier) || math.IsInf(*rule.Multiplier, 0) || *rule.Multiplier <= 0 {
					return nil, nil, errors.New("plan multiplier is invalid")
				}
				multiplier = *rule.Multiplier
				ruleIDs = append(ruleIDs, rule.ID)
				break
			}
			if multiplier == 0 {
				return nil, nil, errors.New("plan multiplier is missing")
			}
		}
		multipliers[index] = multiplier
	}
	return multipliers, ruleIDs, nil
}

func validatePointSet(points []EstimationPoint) string {
	first := points[0]
	if strings.TrimSpace(first.CalculationLogicVersion) == "" || first.CalculationLogicVersion != CalculationLogicVersion {
		return EstimationReasonMixedLogic
	}
	for _, point := range points {
		if point.CalculationIntervalID != first.CalculationIntervalID {
			return EstimationReasonMixedInterval
		}
		if point.LimitDefinitionID != first.LimitDefinitionID {
			return EstimationReasonMixedDefinition
		}
		if point.CycleType != first.CycleType {
			return EstimationReasonMixedCycle
		}
		if point.CalculationLogicVersion != first.CalculationLogicVersion {
			return EstimationReasonMixedLogic
		}
		if len(point.Utilization) != len(point.LimitSeriesIDs) || len(point.LimitSeriesLogicalAccountIDs) != len(point.LimitSeriesIDs) || len(point.LimitSeriesPlanVersionIDs) != len(point.LimitSeriesIDs) || len(point.LimitSeriesCalculationIntervalIDs) != len(point.LimitSeriesIDs) {
			return EstimationReasonTargetMismatch
		}
		if !sameStrings(point.LimitSeriesIDs, first.LimitSeriesIDs) || !sameStrings(point.LimitSeriesLogicalAccountIDs, first.LimitSeriesLogicalAccountIDs) || !sameStrings(point.LimitSeriesPlanVersionIDs, first.LimitSeriesPlanVersionIDs) || !sameStrings(point.LimitSeriesCalculationIntervalIDs, first.LimitSeriesCalculationIntervalIDs) || !sameStringSet(point.CalculationIntervalIDs, first.CalculationIntervalIDs) {
			return EstimationReasonTargetMismatch
		}
	}
	return ""
}

func estimationTrace(points []EstimationPoint) EstimationResult {
	result := EstimationResult{CalculationLogicVersion: CalculationLogicVersion}
	if len(points) > 0 {
		result.LimitSeriesIDs = append([]string(nil), points[0].LimitSeriesIDs...)
		result.LimitSeriesLogicalAccountIDs = append([]string(nil), points[0].LimitSeriesLogicalAccountIDs...)
		result.LimitSeriesCalculationIntervalIDs = append([]string(nil), points[0].LimitSeriesCalculationIntervalIDs...)
		result.LimitSeriesPlanVersionIDs = append([]string(nil), points[0].LimitSeriesPlanVersionIDs...)
	}
	pointIDs := make([]string, 0, len(points))
	observationIDs := make([]string, 0)
	associationIDs := make([]string, 0)
	completenessIDs := make([]string, 0)
	generations := make([]int64, 0)
	ruleVersions := make([]string, 0)
	logicVersions := make([]string, 0)
	for _, point := range points {
		pointIDs = append(pointIDs, point.ID)
		observationIDs = append(observationIDs, matchedObservationIDs(point.MatchedObservations)...)
		associationIDs = append(associationIDs, point.AssociationIDs...)
		completenessIDs = append(completenessIDs, point.CompletenessIDs...)
		for _, observation := range point.MatchedObservations {
			if observation.TimeDelta > result.MaxTimeDelta {
				result.MaxTimeDelta = observation.TimeDelta
			}
			generations = append(generations, observation.NormalizationGeneration)
			ruleVersions = append(ruleVersions, observation.NormalizationRuleVersion)
			logicVersions = append(logicVersions, observation.NormalizationLogicVersion)
		}
	}
	result.PointIDs = uniqueStrings(pointIDs)
	result.ObservationIDs = uniqueStrings(observationIDs)
	result.AssociationIDs = uniqueStrings(associationIDs)
	result.CompletenessIDs = uniqueStrings(completenessIDs)
	sort.Slice(generations, func(a, b int) bool { return generations[a] < generations[b] })
	result.NormalizationGenerations = uniqueInt64s(generations)
	result.NormalizationRuleVersions = uniqueStrings(ruleVersions)
	result.NormalizationLogicVersions = uniqueStrings(logicVersions)
	return result
}

func matchedObservationIDs(observations []MatchedObservation) []string {
	result := make([]string, 0, len(observations))
	for _, observation := range observations {
		result = append(result, observation.ObservationID)
	}
	return result
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func sameStringSet(left, right []string) bool {
	return sameStrings(uniqueStrings(left), uniqueStrings(right))
}

func uniqueInt64s(values []int64) []int64 {
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}
