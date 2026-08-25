package domain

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	MatchingRuleVersion = "t031-nearest-v1"
)

type MatchingObservationRole string

const (
	MatchingRoleLimit MatchingObservationRole = "limit"
	MatchingRoleCost  MatchingObservationRole = "cost"
)

// MatchingLimitObservation は対応観測の判定に必要な利用枠観測メタデータである。
type MatchingLimitObservation struct {
	ID                        string
	ObservedAt                time.Time
	UsedPercent               *float64
	AnalyticsIntervalSeconds  int64
	SyncUploadIntervalMS      *int64
	LimitsRefreshMS           *int64
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	DedupeState               string
}

// MatchingCostObservation は対応観測の判定に必要な利用額観測メタデータである。
type MatchingCostObservation struct {
	ID                        string
	ObservedAt                time.Time
	ValueText                 string
	APIContractSupported      bool
	AnalyticsIntervalSeconds  int64
	SyncUploadIntervalMS      *int64
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	DedupeState               string
}

type MatchingLimitSeries struct {
	CalculationIntervalID string
	LogicalAccountID      string
	UsageLimitSourceID    string
	PlanVersionID         string
	AssociationIDs        []string
	CompletenessIDs       []string
	Observations          []MatchingLimitObservation
}

type MatchingCostSource struct {
	UsageCostSourceID string
	AssociationIDs    []string
	CompletenessIDs   []string
	Complete          bool
	Observations      []MatchingCostObservation
}

// CalculationMatchingInput は一つの方程式系の対象集合である。系列ごとのプラン版は
// 異なり得るが、正式サービス、利用枠定義、周期、半開計算区間は共通する。
type CalculationMatchingInput struct {
	ServiceID              string
	LimitDefinitionID      string
	PlanVersionID          string
	CycleType              string
	CalculationIntervalIDs []string
	ValidFrom              time.Time
	ValidTo                time.Time
	LimitSeries            []MatchingLimitSeries
	CostSources            []MatchingCostSource
	Eligible               bool
}

type MatchedObservation struct {
	ID                        string
	Role                      MatchingObservationRole
	SourceID                  string
	LogicalAccountID          string
	ObservationID             string
	ObservedAt                time.Time
	TimeDelta                 time.Duration
	Tolerance                 time.Duration
	AnalyticsIntervalSeconds  int64
	SyncUploadIntervalMS      *int64
	LimitsRefreshMS           *int64
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
}

func (m MatchedObservation) Validate() error {
	for value, label := range map[string]string{m.ID: "matched observation ID", m.SourceID: "matched source ID", m.ObservationID: "source observation ID", m.NormalizationRuleVersion: "normalization rule version", m.NormalizationLogicVersion: "normalization logic version"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if m.Role != MatchingRoleLimit && m.Role != MatchingRoleCost {
		return fmt.Errorf("unknown matched observation role %q", m.Role)
	}
	if m.ObservedAt.IsZero() || m.TimeDelta < 0 || m.Tolerance < 0 || m.AnalyticsIntervalSeconds <= 0 || m.NormalizationGeneration <= 0 {
		return errors.New("matched observation metadata is invalid")
	}
	if m.SyncUploadIntervalMS == nil || *m.SyncUploadIntervalMS < 0 {
		return errors.New("matched observation sync interval is invalid")
	}
	if m.Role == MatchingRoleLimit && (m.LimitsRefreshMS == nil || *m.LimitsRefreshMS <= 0) {
		return errors.New("matched limit observation refresh interval is invalid")
	}
	return nil
}

func (i CalculationMatchingInput) Validate() error {
	for value, label := range map[string]string{
		i.ServiceID:         "service ID",
		i.LimitDefinitionID: "limit definition ID",
		i.CycleType:         "cycle type",
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("matching %s is required", label)
		}
	}
	if i.ValidFrom.IsZero() || i.ValidTo.IsZero() || !i.ValidFrom.Before(i.ValidTo) {
		return errors.New("matching interval must be a non-empty half-open interval")
	}
	if len(i.CalculationIntervalIDs) == 0 {
		return errors.New("matching input must contain calculation intervals")
	}
	seenIntervals := make(map[string]struct{}, len(i.CalculationIntervalIDs))
	for _, id := range i.CalculationIntervalIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("matching calculation interval ID is required")
		}
		if _, exists := seenIntervals[id]; exists {
			return fmt.Errorf("matching calculation interval ID is duplicated: %s", id)
		}
		seenIntervals[id] = struct{}{}
	}
	seenLimitSources := make(map[string]struct{}, len(i.LimitSeries))
	seenAccounts := make(map[string]struct{}, len(i.LimitSeries))
	for _, series := range i.LimitSeries {
		for value, label := range map[string]string{series.CalculationIntervalID: "limit calculation interval ID", series.LogicalAccountID: "logical account ID", series.UsageLimitSourceID: "usage limit source ID"} {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("matching %s is required", label)
			}
		}
		if _, exists := seenLimitSources[series.UsageLimitSourceID]; exists {
			return fmt.Errorf("matching usage limit source is duplicated: %s", series.UsageLimitSourceID)
		}
		if _, exists := seenAccounts[series.LogicalAccountID]; exists {
			return fmt.Errorf("matching logical account is duplicated: %s", series.LogicalAccountID)
		}
		seenLimitSources[series.UsageLimitSourceID] = struct{}{}
		seenAccounts[series.LogicalAccountID] = struct{}{}
	}
	seenCostSources := make(map[string]struct{}, len(i.CostSources))
	for _, source := range i.CostSources {
		if strings.TrimSpace(source.UsageCostSourceID) == "" {
			return errors.New("matching usage cost source ID is required")
		}
		if _, exists := seenCostSources[source.UsageCostSourceID]; exists {
			return fmt.Errorf("matching usage cost source is duplicated: %s", source.UsageCostSourceID)
		}
		seenCostSources[source.UsageCostSourceID] = struct{}{}
	}
	return nil
}

func (p EstimationPoint) Validate() error {
	for value, label := range map[string]string{p.ID: "estimation point ID", p.ServiceID: "service ID", p.LimitDefinitionID: "limit definition ID", p.CalculationIntervalID: "calculation interval ID", p.MatchingRuleVersion: "matching rule version", p.CalculationLogicVersion: "calculation logic version"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("estimation point %s is required", label)
		}
	}
	if p.ReferenceAt.IsZero() || p.CreatedAt.IsZero() || p.UpdatedAt.IsZero() {
		return errors.New("estimation point timestamps are required")
	}
	if len(p.MatchedObservations) == 0 || len(p.LimitSeriesIDs) == 0 || len(p.CostSourceIDs) == 0 {
		return errors.New("estimation point sources are required")
	}
	if math.IsNaN(p.SharedCost) || math.IsInf(p.SharedCost, 0) || p.SharedCost < 0 || len(p.Utilization) != len(p.LimitSeriesIDs) {
		return errors.New("estimation point numeric values are invalid")
	}
	for _, utilization := range p.Utilization {
		if math.IsNaN(utilization) || math.IsInf(utilization, 0) || utilization < 0 || utilization > 1 {
			return errors.New("estimation point utilization is invalid")
		}
	}
	for _, observation := range p.MatchedObservations {
		if err := observation.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// BuildEstimationPoints は一つの計算対象から完全な最近傍対応観測を選ぶ。
// 欠落ソースを部分値で補完しない。
func BuildEstimationPoints(input CalculationMatchingInput, newID func() string, now time.Time) ([]EstimationPoint, error) {
	if err := input.Validate(); err != nil {
		return nil, err
	}
	if newID == nil || now.IsZero() {
		return nil, errors.New("estimation point ID generator and clock are required")
	}
	if !input.Eligible {
		return nil, nil
	}
	if len(input.LimitSeries) == 0 || len(input.CostSources) == 0 {
		return nil, nil
	}
	for _, source := range input.CostSources {
		if !source.Complete {
			return nil, nil
		}
	}
	for _, series := range input.LimitSeries {
		if len(series.Observations) == 0 {
			return nil, nil
		}
	}
	candidates := make([]time.Time, 0)
	for _, series := range input.LimitSeries {
		for _, observation := range series.Observations {
			if matchingLimitObservationUsable(observation, input.ValidFrom, input.ValidTo) {
				candidates = append(candidates, observation.ObservedAt.UTC())
			}
		}
	}
	sort.Slice(candidates, func(a, b int) bool { return candidates[a].Before(candidates[b]) })
	candidates = uniqueTimes(candidates)
	points := make([]EstimationPoint, 0, len(candidates))
	seenInput := make(map[string]struct{})
	for _, referenceAt := range candidates {
		selectedLimits := make([]selectedLimit, 0, len(input.LimitSeries))
		valid := true
		for _, series := range input.LimitSeries {
			observation, delta, ok := nearestLimitObservation(series.Observations, referenceAt, input.ValidFrom, input.ValidTo)
			if !ok {
				valid = false
				break
			}
			selectedLimits = append(selectedLimits, selectedLimit{series: series, observation: observation, delta: delta})
		}
		if !valid {
			continue
		}
		selectedCosts := make([]selectedCost, 0, len(input.CostSources))
		for _, source := range input.CostSources {
			observation, delta, ok := nearestCostObservation(source.Observations, referenceAt, input.ValidFrom, input.ValidTo)
			if !ok {
				valid = false
				break
			}
			selectedCosts = append(selectedCosts, selectedCost{source: source, observation: observation, delta: delta})
		}
		if !valid || !matchedWithinEveryTolerance(selectedLimits, selectedCosts) {
			continue
		}
		sharedCost, utilization, ok := matchingValues(selectedLimits, selectedCosts)
		if !ok {
			continue
		}
		key := matchedObservationKey(selectedLimits, selectedCosts)
		if _, exists := seenInput[key]; exists {
			continue
		}
		seenInput[key] = struct{}{}
		point := EstimationPoint{
			SharedCost:              sharedCost,
			Utilization:             utilization,
			ID:                      newID(),
			ServiceID:               input.ServiceID,
			LimitDefinitionID:       input.LimitDefinitionID,
			PlanVersionID:           input.PlanVersionID,
			CycleType:               input.CycleType,
			CalculationIntervalID:   input.CalculationIntervalIDs[0],
			CalculationIntervalIDs:  append([]string(nil), input.CalculationIntervalIDs...),
			ReferenceAt:             referenceAt,
			MatchingRuleVersion:     MatchingRuleVersion,
			CalculationLogicVersion: CalculationLogicVersion,
			CreatedAt:               now.UTC(),
			UpdatedAt:               now.UTC(),
		}
		for _, selected := range selectedLimits {
			point.LimitSeriesIDs = append(point.LimitSeriesIDs, selected.series.UsageLimitSourceID)
			point.AssociationIDs = append(point.AssociationIDs, selected.series.AssociationIDs...)
			point.CompletenessIDs = append(point.CompletenessIDs, selected.series.CompletenessIDs...)
			point.MatchedObservations = append(point.MatchedObservations, MatchedObservation{
				ID: newID(), Role: MatchingRoleLimit, SourceID: selected.series.UsageLimitSourceID,
				LogicalAccountID: selected.series.LogicalAccountID, ObservationID: selected.observation.ID,
				ObservedAt: selected.observation.ObservedAt.UTC(), TimeDelta: selected.delta,
				Tolerance: minCostTolerance(selected.observation, selectedCosts), AnalyticsIntervalSeconds: selected.observation.AnalyticsIntervalSeconds,
				SyncUploadIntervalMS: cloneInt64(selected.observation.SyncUploadIntervalMS), LimitsRefreshMS: cloneInt64(selected.observation.LimitsRefreshMS),
				NormalizationGeneration: selected.observation.NormalizationGeneration, NormalizationRuleVersion: selected.observation.NormalizationRuleVersion,
				NormalizationLogicVersion: selected.observation.NormalizationLogicVersion,
			})
		}
		for _, selected := range selectedCosts {
			point.CostSourceIDs = append(point.CostSourceIDs, selected.source.UsageCostSourceID)
			point.AssociationIDs = append(point.AssociationIDs, selected.source.AssociationIDs...)
			point.CompletenessIDs = append(point.CompletenessIDs, selected.source.CompletenessIDs...)
			point.MatchedObservations = append(point.MatchedObservations, MatchedObservation{
				ID: newID(), Role: MatchingRoleCost, SourceID: selected.source.UsageCostSourceID,
				ObservationID: selected.observation.ID, ObservedAt: selected.observation.ObservedAt.UTC(), TimeDelta: selected.delta,
				Tolerance: minLimitTolerance(selected.observation, selectedLimits), AnalyticsIntervalSeconds: selected.observation.AnalyticsIntervalSeconds,
				SyncUploadIntervalMS:    cloneInt64(selected.observation.SyncUploadIntervalMS),
				NormalizationGeneration: selected.observation.NormalizationGeneration, NormalizationRuleVersion: selected.observation.NormalizationRuleVersion,
				NormalizationLogicVersion: selected.observation.NormalizationLogicVersion,
			})
		}
		point.LimitSeriesIDs = uniqueStrings(point.LimitSeriesIDs)
		point.CostSourceIDs = uniqueStrings(point.CostSourceIDs)
		point.AssociationIDs = uniqueStrings(point.AssociationIDs)
		point.CompletenessIDs = uniqueStrings(point.CompletenessIDs)
		if err := point.Validate(); err != nil {
			return nil, err
		}
		points = append(points, point)
	}
	return points, nil
}

func matchingValues(limits []selectedLimit, costs []selectedCost) (float64, []float64, bool) {
	var sharedCost float64
	for _, selected := range costs {
		value, err := strconv.ParseFloat(strings.TrimSpace(selected.observation.ValueText), 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return 0, nil, false
		}
		sharedCost += value
		if math.IsInf(sharedCost, 0) || math.IsNaN(sharedCost) {
			return 0, nil, false
		}
	}
	utilization := make([]float64, 0, len(limits))
	for _, selected := range limits {
		if selected.observation.UsedPercent == nil || math.IsNaN(*selected.observation.UsedPercent) || math.IsInf(*selected.observation.UsedPercent, 0) || *selected.observation.UsedPercent < 0 || *selected.observation.UsedPercent > 100 {
			return 0, nil, false
		}
		utilization = append(utilization, *selected.observation.UsedPercent/100)
	}
	return sharedCost, utilization, true
}

type selectedLimit struct {
	series      MatchingLimitSeries
	observation MatchingLimitObservation
	delta       time.Duration
}

type selectedCost struct {
	source      MatchingCostSource
	observation MatchingCostObservation
	delta       time.Duration
}

func matchingLimitObservationUsable(observation MatchingLimitObservation, start, end time.Time) bool {
	if observation.ID == "" || observation.ObservedAt.IsZero() || observation.ObservedAt.Before(start) || !observation.ObservedAt.Before(end) || observation.DedupeState != "canonical" || observation.AnalyticsIntervalSeconds <= 0 || observation.NormalizationGeneration <= 0 || strings.TrimSpace(observation.NormalizationRuleVersion) == "" || strings.TrimSpace(observation.NormalizationLogicVersion) == "" {
		return false
	}
	if observation.SyncUploadIntervalMS == nil || *observation.SyncUploadIntervalMS < 0 || observation.LimitsRefreshMS == nil || *observation.LimitsRefreshMS <= 0 {
		return false
	}
	return observation.UsedPercent != nil && !math.IsNaN(*observation.UsedPercent) && !math.IsInf(*observation.UsedPercent, 0) && *observation.UsedPercent >= 0 && *observation.UsedPercent <= 100
}

func matchingCostObservationUsable(observation MatchingCostObservation, start, end time.Time) bool {
	if observation.ID == "" || observation.ObservedAt.IsZero() || observation.ObservedAt.Before(start) || !observation.ObservedAt.Before(end) || observation.DedupeState != "canonical" || !observation.APIContractSupported || observation.AnalyticsIntervalSeconds <= 0 || observation.NormalizationGeneration <= 0 || strings.TrimSpace(observation.NormalizationRuleVersion) == "" || strings.TrimSpace(observation.NormalizationLogicVersion) == "" {
		return false
	}
	return observation.SyncUploadIntervalMS != nil && *observation.SyncUploadIntervalMS >= 0
}

func nearestLimitObservation(observations []MatchingLimitObservation, referenceAt, start, end time.Time) (MatchingLimitObservation, time.Duration, bool) {
	usable := make([]MatchingLimitObservation, 0, len(observations))
	for _, observation := range observations {
		if matchingLimitObservationUsable(observation, start, end) {
			usable = append(usable, observation)
		}
	}
	return nearestLimit(usable, referenceAt)
}

func nearestCostObservation(observations []MatchingCostObservation, referenceAt, start, end time.Time) (MatchingCostObservation, time.Duration, bool) {
	usable := make([]MatchingCostObservation, 0, len(observations))
	for _, observation := range observations {
		if matchingCostObservationUsable(observation, start, end) {
			usable = append(usable, observation)
		}
	}
	observation, delta, ok := nearestCost(usable, referenceAt)
	return observation, delta, ok
}

func nearestLimit(observations []MatchingLimitObservation, referenceAt time.Time) (MatchingLimitObservation, time.Duration, bool) {
	if len(observations) == 0 {
		return MatchingLimitObservation{}, 0, false
	}
	sort.SliceStable(observations, func(a, b int) bool {
		return nearestBefore(observations[a].ObservedAt, observations[b].ObservedAt, referenceAt, observations[a].ID, observations[b].ID)
	})
	bestDelta := absoluteDuration(observations[0].ObservedAt.Sub(referenceAt))
	if len(observations) > 1 && absoluteDuration(observations[1].ObservedAt.Sub(referenceAt)) == bestDelta && observations[1].ObservedAt.Equal(observations[0].ObservedAt) {
		return MatchingLimitObservation{}, 0, false
	}
	return observations[0], bestDelta, true
}

func nearestCost(observations []MatchingCostObservation, referenceAt time.Time) (MatchingCostObservation, time.Duration, bool) {
	if len(observations) == 0 {
		return MatchingCostObservation{}, 0, false
	}
	sort.SliceStable(observations, func(a, b int) bool {
		return nearestBefore(observations[a].ObservedAt, observations[b].ObservedAt, referenceAt, observations[a].ID, observations[b].ID)
	})
	bestDelta := absoluteDuration(observations[0].ObservedAt.Sub(referenceAt))
	if len(observations) > 1 && absoluteDuration(observations[1].ObservedAt.Sub(referenceAt)) == bestDelta && observations[1].ObservedAt.Equal(observations[0].ObservedAt) {
		return MatchingCostObservation{}, 0, false
	}
	return observations[0], bestDelta, true
}

func nearestBefore(a, b, referenceAt time.Time, aID, bID string) bool {
	aDelta := absoluteDuration(a.Sub(referenceAt))
	bDelta := absoluteDuration(b.Sub(referenceAt))
	if aDelta != bDelta {
		return aDelta < bDelta
	}
	aBefore := !a.After(referenceAt)
	bBefore := !b.After(referenceAt)
	if aBefore != bBefore {
		return aBefore
	}
	if !a.Equal(b) {
		return a.Before(b)
	}
	return aID < bID
}

func matchedWithinEveryTolerance(limits []selectedLimit, costs []selectedCost) bool {
	for _, limit := range limits {
		for _, cost := range costs {
			tolerance, ok := matchingTolerance(limit.observation, cost.observation)
			if !ok || limit.delta > tolerance || cost.delta > tolerance {
				return false
			}
		}
	}
	return true
}

func matchingTolerance(limit MatchingLimitObservation, cost MatchingCostObservation) (time.Duration, bool) {
	values := []int64{limit.AnalyticsIntervalSeconds, cost.AnalyticsIntervalSeconds}
	for _, value := range values {
		if value <= 0 || time.Duration(value) > time.Duration(math.MaxInt64)/time.Second {
			return 0, false
		}
	}
	maxValue := time.Duration(limit.AnalyticsIntervalSeconds) * time.Second
	costValue := time.Duration(cost.AnalyticsIntervalSeconds) * time.Second
	if costValue > maxValue {
		maxValue = costValue
	}
	for _, value := range []*int64{cost.SyncUploadIntervalMS, limit.SyncUploadIntervalMS, limit.LimitsRefreshMS} {
		if value == nil || *value < 0 || time.Duration(*value) > time.Duration(math.MaxInt64)/time.Millisecond {
			return 0, false
		}
		candidate := time.Duration(*value) * time.Millisecond
		if candidate > maxValue {
			maxValue = candidate
		}
	}
	return maxValue, true
}

func minCostTolerance(limit MatchingLimitObservation, costs []selectedCost) time.Duration {
	var result time.Duration
	set := false
	for _, cost := range costs {
		if value, ok := matchingTolerance(limit, cost.observation); ok && (!set || value < result) {
			result = value
			set = true
		}
	}
	return result
}

func minLimitTolerance(cost MatchingCostObservation, limits []selectedLimit) time.Duration {
	var result time.Duration
	set := false
	for _, limit := range limits {
		value, ok := matchingTolerance(limit.observation, cost)
		if ok && (!set || value < result) {
			result = value
			set = true
		}
	}
	return result
}

func matchedObservationKey(limits []selectedLimit, costs []selectedCost) string {
	parts := make([]string, 0, len(limits)+len(costs))
	for _, item := range limits {
		parts = append(parts, fmt.Sprintf("limit:%s:%d", item.observation.ID, item.observation.NormalizationGeneration))
	}
	for _, item := range costs {
		parts = append(parts, fmt.Sprintf("cost:%s:%d", item.observation.ID, item.observation.NormalizationGeneration))
	}
	sort.Strings(parts)
	return strings.Join(parts, "|")
}

func uniqueTimes(values []time.Time) []time.Time {
	if len(values) == 0 {
		return nil
	}
	result := []time.Time{values[0]}
	for _, value := range values[1:] {
		if !value.Equal(result[len(result)-1]) {
			result = append(result, value)
		}
	}
	return result
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func absoluteDuration(value time.Duration) time.Duration {
	if value < 0 {
		if value == time.Duration(math.MinInt64) {
			return time.Duration(math.MaxInt64)
		}
		return -value
	}
	return value
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}
