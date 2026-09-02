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
	LimitCycleWeekly   = "weekly"
	LimitCycleBilling  = "billing"
	LimitCycleSession  = "session"
	LimitCycleFiveHour = "five_hour"
	LimitCycleBalance  = "balance"
	LimitCycleCredit   = "credit"
	LimitCycleUsage    = "usage"
	LimitCycleCredits  = "credits"
	LimitCycleSpend    = "spend"
)

type CalculationBoundaryKind string

const (
	BoundaryReset               CalculationBoundaryKind = "reset"
	BoundaryPlanHistory         CalculationBoundaryKind = "plan_history"
	BoundaryAssociation         CalculationBoundaryKind = "association"
	BoundaryCompleteness        CalculationBoundaryKind = "completeness"
	BoundaryHubSwitch           CalculationBoundaryKind = "hub_switch"
	BoundaryAPIContract         CalculationBoundaryKind = "api_contract"
	BoundaryUnexplainedDecrease CalculationBoundaryKind = "unexplained_decrease"
)

type CalculationIntervalState string

const (
	CalculationEstimable CalculationIntervalState = "estimable"
	CalculationExcluded  CalculationIntervalState = "excluded"
)

type CalculationExclusionReason string

const (
	ExclusionUnsupportedCycle        CalculationExclusionReason = "unsupported_cycle"
	ExclusionSessionCycle            CalculationExclusionReason = "session"
	ExclusionFiveHourCycle           CalculationExclusionReason = "five_hour"
	ExclusionBalanceCycle            CalculationExclusionReason = "balance"
	ExclusionCreditCycle             CalculationExclusionReason = "credit"
	ExclusionUsageCycle              CalculationExclusionReason = "usage_amount"
	ExclusionCreditsCycle            CalculationExclusionReason = "credits"
	ExclusionSpendCycle              CalculationExclusionReason = "spend"
	ExclusionBillingUnconfirmed      CalculationExclusionReason = "billing_unconfirmed"
	ExclusionPlanHistoryUnknown      CalculationExclusionReason = "plan_history_unknown"
	ExclusionAssociationUnknown      CalculationExclusionReason = "association_unknown"
	ExclusionCompletenessUnconfirmed CalculationExclusionReason = "completeness_unconfirmed"
	ExclusionHubSwitchWithoutReset   CalculationExclusionReason = "hub_switch_without_reset"
)

type CalculationBoundary struct {
	ID                 string
	ServiceID          string
	LogicalAccountID   string
	UsageLimitSourceID string
	At                 time.Time
	Kind               CalculationBoundaryKind
	Reason             string
	RelatedID          string
	CreatedAt          time.Time
}

type CalculationInterval struct {
	ID                 string
	ServiceID          string
	LogicalAccountID   string
	UsageLimitSourceID string
	LimitDefinitionID  string
	PlanVersionID      string
	CycleType          string
	ValidFrom          time.Time
	ValidTo            time.Time
	State              CalculationIntervalState
	ExclusionReason    CalculationExclusionReason
	BoundaryIDs        []string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type CalculationBuildRequest struct {
	ServiceID string
	ValidFrom time.Time
	ValidTo   time.Time
}

type CalculationObservation struct {
	ID          string
	ObservedAt  time.Time
	ResetAt     *time.Time
	APIContract string
	UsedPercent *float64
}

type CalculationCostObservation struct {
	ID         string
	ObservedAt time.Time
	ValueText  string
}

type CalculationCostSource struct {
	ID                 string
	AssociationPeriods []CalculationPeriod
	Completeness       []CalculationCompleteness
	Observations       []CalculationCostObservation
}

type CalculationPeriod struct {
	ID        string
	ValidFrom time.Time
	ValidTo   *time.Time
}

type CalculationCompleteness struct {
	ID                string
	ValidFrom         time.Time
	ValidTo           *time.Time
	State             CompletenessState
	LogicalAccountIDs []string
	ExcludedActivity  []string
}

type CalculationSeries struct {
	ServiceID           string
	LogicalAccountID    string
	UsageLimitSourceID  string
	LimitDefinitionID   string
	CycleType           string
	BillingConfirmation BillingConfirmation
	Association         CalculationPeriod
	Observations        []CalculationObservation
	PlanHistories       []PlanHistory
	CostSources         []CalculationCostSource
	HubSwitches         []HubSwitch
}

func (r CalculationBuildRequest) Validate() error {
	if strings.TrimSpace(r.ServiceID) == "" {
		return errors.New("calculation service ID is required")
	}
	if r.ValidFrom.IsZero() || r.ValidTo.IsZero() || !r.ValidFrom.Before(r.ValidTo) {
		return errors.New("calculation build period must be a non-empty half-open interval")
	}
	return nil
}

func (b CalculationBoundary) Validate() error {
	for value, label := range map[string]string{b.ID: "calculation boundary ID", b.ServiceID: "service ID", b.LogicalAccountID: "logical account ID", b.UsageLimitSourceID: "usage limit source ID", b.Reason: "calculation boundary reason"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if b.At.IsZero() || b.CreatedAt.IsZero() {
		return errors.New("calculation boundary timestamps are required")
	}
	switch b.Kind {
	case BoundaryReset, BoundaryPlanHistory, BoundaryAssociation, BoundaryCompleteness, BoundaryHubSwitch, BoundaryAPIContract, BoundaryUnexplainedDecrease:
	default:
		return fmt.Errorf("unknown calculation boundary kind %q", b.Kind)
	}
	return nil
}

func (i CalculationInterval) Validate() error {
	for value, label := range map[string]string{i.ID: "calculation interval ID", i.ServiceID: "service ID", i.LogicalAccountID: "logical account ID", i.UsageLimitSourceID: "usage limit source ID", i.LimitDefinitionID: "limit definition ID", i.CycleType: "cycle type"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if i.ValidFrom.IsZero() || i.ValidTo.IsZero() || !i.ValidFrom.Before(i.ValidTo) {
		return errors.New("calculation interval must be a non-empty half-open interval")
	}
	if i.State != CalculationEstimable && i.State != CalculationExcluded {
		return fmt.Errorf("unknown calculation interval state %q", i.State)
	}
	if i.State == CalculationExcluded && strings.TrimSpace(string(i.ExclusionReason)) == "" {
		return errors.New("excluded calculation interval requires a reason")
	}
	if i.State == CalculationEstimable && i.ExclusionReason != "" {
		return errors.New("estimable calculation interval cannot have an exclusion reason")
	}
	if i.CreatedAt.IsZero() || i.UpdatedAt.IsZero() {
		return errors.New("calculation interval timestamps are required")
	}
	return nil
}

func (s CalculationSeries) Validate() error {
	for value, label := range map[string]string{s.ServiceID: "service ID", s.LogicalAccountID: "logical account ID", s.UsageLimitSourceID: "usage limit source ID", s.LimitDefinitionID: "limit definition ID", s.CycleType: "cycle type"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if err := ValidatePeriod(s.Association.ValidFrom, s.Association.ValidTo); err != nil {
		return fmt.Errorf("calculation association: %w", err)
	}
	return nil
}

// DeriveCalculationIntervals creates intervals only between known reset
// boundaries. It never invents a timestamp for an unknown boundary.
func DeriveCalculationIntervals(series CalculationSeries, request CalculationBuildRequest, newID func() string, now time.Time) ([]CalculationInterval, []CalculationBoundary, error) {
	if err := request.Validate(); err != nil {
		return nil, nil, err
	}
	if err := series.Validate(); err != nil {
		return nil, nil, err
	}
	if newID == nil || now.IsZero() {
		return nil, nil, errors.New("calculation interval ID generator and clock are required")
	}
	observations := append([]CalculationObservation(nil), series.Observations...)
	sort.Slice(observations, func(a, b int) bool {
		if observations[a].ObservedAt.Equal(observations[b].ObservedAt) {
			return observations[a].ID < observations[b].ID
		}
		return observations[a].ObservedAt.Before(observations[b].ObservedAt)
	})
	resetTimes := uniqueResetTimes(observations, series.CycleType, request)
	if len(resetTimes) < 2 {
		return nil, nil, nil
	}
	boundaries := make([]CalculationBoundary, 0)
	boundaryByKey := make(map[string]string)
	addBoundary := func(at time.Time, kind CalculationBoundaryKind, reason, relatedID string) string {
		key := fmt.Sprintf("%s|%s|%s", at.UTC().Format(time.RFC3339Nano), kind, relatedID)
		if existing, ok := boundaryByKey[key]; ok {
			return existing
		}
		boundary := CalculationBoundary{ID: newID(), ServiceID: series.ServiceID, LogicalAccountID: series.LogicalAccountID, UsageLimitSourceID: series.UsageLimitSourceID, At: at.UTC(), Kind: kind, Reason: reason, RelatedID: relatedID, CreatedAt: now.UTC()}
		boundaries = append(boundaries, boundary)
		boundaryByKey[key] = boundary.ID
		return boundary.ID
	}
	for _, reset := range resetTimes {
		addBoundary(reset, BoundaryReset, "confirmed reset boundary", "")
	}

	result := make([]CalculationInterval, 0)
	for index := 0; index+1 < len(resetTimes); index++ {
		cycleStart, cycleEnd := resetTimes[index], resetTimes[index+1]
		if cycleEnd.Before(request.ValidFrom) || !cycleStart.Before(request.ValidTo) {
			continue
		}
		start, end := maxTime(cycleStart, request.ValidFrom), minTime(cycleEnd, request.ValidTo)
		if !start.Before(end) {
			continue
		}
		points := []time.Time{start, end}
		appendPeriodPoints(&points, series.Association, start, end)
		for _, history := range series.PlanHistories {
			appendPeriodPoints(&points, CalculationPeriod{ID: history.ID, ValidFrom: history.ValidFrom, ValidTo: history.ValidTo}, start, end)
			if !history.ValidFrom.Before(start) && !history.ValidFrom.After(end) {
				addBoundary(history.ValidFrom, BoundaryPlanHistory, "plan history boundary", history.ID)
			}
			if history.ValidTo != nil && !history.ValidTo.Before(start) && !history.ValidTo.After(end) {
				addBoundary(*history.ValidTo, BoundaryPlanHistory, "plan history boundary", history.ID)
			}
		}
		for _, source := range series.CostSources {
			for _, period := range source.AssociationPeriods {
				appendPeriodPoints(&points, period, start, end)
				if !period.ValidFrom.Before(start) && !period.ValidFrom.After(end) {
					addBoundary(period.ValidFrom, BoundaryAssociation, "usage cost association boundary", period.ID)
				}
				if period.ValidTo != nil && !period.ValidTo.Before(start) && !period.ValidTo.After(end) {
					addBoundary(*period.ValidTo, BoundaryAssociation, "usage cost association boundary", period.ID)
				}
			}
			for _, completeness := range source.Completeness {
				appendPeriodPoints(&points, CalculationPeriod{ID: completeness.ID, ValidFrom: completeness.ValidFrom, ValidTo: completeness.ValidTo}, start, end)
				if !completeness.ValidFrom.Before(start) && !completeness.ValidFrom.After(end) {
					addBoundary(completeness.ValidFrom, BoundaryCompleteness, "activity completeness boundary", completeness.ID)
				}
				if completeness.ValidTo != nil && !completeness.ValidTo.Before(start) && !completeness.ValidTo.After(end) {
					addBoundary(*completeness.ValidTo, BoundaryCompleteness, "activity completeness boundary", completeness.ID)
				}
			}
			for _, cost := range source.Observations {
				if cost.ObservedAt.After(start) && cost.ObservedAt.Before(end) {
					if previous, ok := previousCost(source, cost); ok {
						previousValue, previousErr := strconv.ParseFloat(previous.ValueText, 64)
						currentValue, currentErr := strconv.ParseFloat(cost.ValueText, 64)
						if previousErr != nil || currentErr != nil || math.IsNaN(previousValue) || math.IsNaN(currentValue) || math.IsInf(previousValue, 0) || math.IsInf(currentValue, 0) {
							continue
						}
						if currentValue < previousValue {
							points = append(points, cost.ObservedAt)
							addBoundary(cost.ObservedAt, BoundaryUnexplainedDecrease, "unexplained cumulative usage decrease", cost.ID)
						}
					}
				}
			}
		}
		for _, observation := range observations {
			if observation.APIContract == "" {
				continue
			}
			if observation.ObservedAt.After(start) && observation.ObservedAt.Before(end) {
				previous, ok := previousContract(observations, observation)
				if ok && previous != observation.APIContract {
					points = append(points, observation.ObservedAt)
					addBoundary(observation.ObservedAt, BoundaryAPIContract, "API contract change", observation.ID)
				}
			}
		}
		for _, switchRecord := range series.HubSwitches {
			if !switchRecord.SwitchedAt.Before(start) && !switchRecord.SwitchedAt.After(end) {
				if switchRecord.SwitchedAt.After(start) && switchRecord.SwitchedAt.Before(end) {
					points = append(points, switchRecord.SwitchedAt)
				}
				addBoundary(switchRecord.SwitchedAt, BoundaryHubSwitch, "confirmed Hub switch", switchRecord.ID)
			}
		}
		points = uniqueSortedPoints(points)
		mismatch := hubSwitchMismatches(series.HubSwitches, cycleStart, cycleEnd, resetTimes)
		for pointIndex := 0; pointIndex+1 < len(points); pointIndex++ {
			segmentStart, segmentEnd := points[pointIndex], points[pointIndex+1]
			if !segmentStart.Before(segmentEnd) {
				continue
			}
			state, reason, planVersion := segmentEligibility(series, segmentStart, segmentEnd, mismatch)
			ids := boundaryIDsAt(boundaries, segmentStart, segmentEnd)
			result = append(result, CalculationInterval{ID: newID(), ServiceID: series.ServiceID, LogicalAccountID: series.LogicalAccountID, UsageLimitSourceID: series.UsageLimitSourceID, LimitDefinitionID: series.LimitDefinitionID, PlanVersionID: planVersion, CycleType: series.CycleType, ValidFrom: segmentStart, ValidTo: segmentEnd, State: state, ExclusionReason: reason, BoundaryIDs: ids, CreatedAt: now.UTC(), UpdatedAt: now.UTC()})
		}
	}
	for index := range boundaries {
		if err := boundaries[index].Validate(); err != nil {
			return nil, nil, err
		}
	}
	for index := range result {
		if err := result[index].Validate(); err != nil {
			return nil, nil, err
		}
	}
	return result, boundaries, nil
}

func uniqueResetTimes(observations []CalculationObservation, cycleType string, request CalculationBuildRequest) []time.Time {
	rawTimes := make([]time.Time, 0)
	for _, observation := range observations {
		if observation.ResetAt == nil {
			continue
		}
		reset := observation.ResetAt.UTC()
		rawTimes = append(rawTimes, reset)
		switch cycleType {
		case LimitCycleWeekly:
			rawTimes = append(rawTimes, reset.AddDate(0, 0, -7))
		case LimitCycleBilling:
			rawTimes = append(rawTimes, reset.AddDate(0, -1, 0))
		}
	}
	sort.Slice(rawTimes, func(a, b int) bool { return rawTimes[a].Before(rawTimes[b]) })

	clustered := make([]time.Time, 0)
	for _, t := range rawTimes {
		if t.Before(request.ValidFrom) || t.After(request.ValidTo) {
			continue
		}
		if len(clustered) == 0 {
			clustered = append(clustered, t)
			continue
		}
		last := clustered[len(clustered)-1]
		if t.Sub(last) <= 10*time.Minute {
			continue
		}
		clustered = append(clustered, t)
	}
	return clustered
}

func appendPeriodPoints(points *[]time.Time, period CalculationPeriod, start, end time.Time) {
	if period.ValidFrom.After(start) && period.ValidFrom.Before(end) {
		*points = append(*points, period.ValidFrom)
	}
	if period.ValidTo != nil && period.ValidTo.After(start) && period.ValidTo.Before(end) {
		*points = append(*points, *period.ValidTo)
	}
}

func previousCost(source CalculationCostSource, current CalculationCostObservation) (CalculationCostObservation, bool) {
	var previous CalculationCostObservation
	ok := false
	for _, candidate := range source.Observations {
		if !candidate.ObservedAt.Before(current.ObservedAt) {
			continue
		}
		if !ok || candidate.ObservedAt.After(previous.ObservedAt) || (candidate.ObservedAt.Equal(previous.ObservedAt) && candidate.ID > previous.ID) {
			previous, ok = candidate, true
		}
	}
	return previous, ok
}

func previousContract(observations []CalculationObservation, current CalculationObservation) (string, bool) {
	var previous CalculationObservation
	ok := false
	for _, candidate := range observations {
		if candidate.APIContract == "" || !candidate.ObservedAt.Before(current.ObservedAt) {
			continue
		}
		if !ok || candidate.ObservedAt.After(previous.ObservedAt) || (candidate.ObservedAt.Equal(previous.ObservedAt) && candidate.ID > previous.ID) {
			previous, ok = candidate, true
		}
	}
	return previous.APIContract, ok
}

func hubSwitchMismatches(switches []HubSwitch, start, end time.Time, resets []time.Time) bool {
	for _, switchRecord := range switches {
		if !switchRecord.SwitchedAt.After(start) || !switchRecord.SwitchedAt.Before(end) {
			continue
		}
		matched := false
		for _, reset := range resets {
			if switchRecord.SwitchedAt.Equal(reset) {
				matched = true
				break
			}
		}
		if !matched {
			return true
		}
	}
	return false
}

func segmentEligibility(series CalculationSeries, start, end time.Time, switchMismatch bool) (CalculationIntervalState, CalculationExclusionReason, string) {
	if switchMismatch {
		return CalculationExcluded, ExclusionHubSwitchWithoutReset, ""
	}
	if reason := cycleExclusion(series.CycleType, series.BillingConfirmation); reason != "" {
		return CalculationExcluded, reason, ""
	}
	planVersion := ""
	for _, history := range series.PlanHistories {
		if periodContains(history.ValidFrom, history.ValidTo, start) && periodContains(history.ValidFrom, history.ValidTo, end.Add(-time.Nanosecond)) {
			if planVersion != "" && planVersion != history.PlanVersionID {
				return CalculationExcluded, ExclusionPlanHistoryUnknown, ""
			}
			planVersion = history.PlanVersionID
		}
	}
	if planVersion == "" {
		return CalculationExcluded, ExclusionPlanHistoryUnknown, ""
	}
	if !periodContains(series.Association.ValidFrom, series.Association.ValidTo, start) || !periodContains(series.Association.ValidFrom, series.Association.ValidTo, end.Add(-time.Nanosecond)) {
		return CalculationExcluded, ExclusionAssociationUnknown, planVersion
	}
	for _, source := range series.CostSources {
		if !costSourceComplete(source, series.LogicalAccountID, start, end) {
			return CalculationExcluded, ExclusionCompletenessUnconfirmed, planVersion
		}
	}
	if len(series.CostSources) == 0 {
		return CalculationExcluded, ExclusionCompletenessUnconfirmed, planVersion
	}
	return CalculationEstimable, "", planVersion
}

func cycleExclusion(cycle string, billing BillingConfirmation) CalculationExclusionReason {
	switch cycle {
	case LimitCycleWeekly:
		return ""
	case LimitCycleBilling:
		if billing == BillingConfirmed {
			return ""
		}
		return ExclusionBillingUnconfirmed
	case LimitCycleSession:
		return ExclusionSessionCycle
	case LimitCycleFiveHour:
		return ExclusionFiveHourCycle
	case LimitCycleBalance:
		return ExclusionBalanceCycle
	case LimitCycleCredit:
		return ExclusionCreditCycle
	case LimitCycleUsage:
		return ExclusionUsageCycle
	case LimitCycleCredits:
		return ExclusionCreditsCycle
	case LimitCycleSpend:
		return ExclusionSpendCycle
	default:
		return ExclusionUnsupportedCycle
	}
}

func costSourceComplete(source CalculationCostSource, logicalAccountID string, start, end time.Time) bool {
	if len(source.AssociationPeriods) == 0 || len(source.Completeness) == 0 {
		return false
	}
	for _, association := range source.AssociationPeriods {
		if !periodContains(association.ValidFrom, association.ValidTo, start) || !periodContains(association.ValidFrom, association.ValidTo, end.Add(-time.Nanosecond)) {
			continue
		}
		cursor := start
		for cursor.Before(end) {
			found := false
			for _, completeness := range source.Completeness {
				if !periodContains(completeness.ValidFrom, completeness.ValidTo, cursor) {
					continue
				}
				if completeness.State != CompletenessConfirmed || len(completeness.ExcludedActivity) != 0 || !containsString(completeness.LogicalAccountIDs, logicalAccountID) {
					return false
				}
				segmentEnd := end
				if completeness.ValidTo != nil && completeness.ValidTo.Before(segmentEnd) {
					segmentEnd = *completeness.ValidTo
				}
				cursor = segmentEnd
				found = true
				break
			}
			if !found {
				return false
			}
		}
		return true
	}
	return false
}

func periodContains(start time.Time, end *time.Time, point time.Time) bool {
	if point.Before(start) {
		return false
	}
	return end == nil || point.Before(*end)
}

func boundaryIDsAt(boundaries []CalculationBoundary, start, end time.Time) []string {
	result := make([]string, 0)
	for _, boundary := range boundaries {
		if boundary.At.Equal(start) || boundary.At.Equal(end) {
			result = append(result, boundary.ID)
		}
	}
	sort.Strings(result)
	return result
}

func uniqueSortedPoints(points []time.Time) []time.Time {
	seen := make(map[string]time.Time, len(points))
	for _, point := range points {
		seen[point.UTC().Format(time.RFC3339Nano)] = point.UTC()
	}
	result := make([]time.Time, 0, len(seen))
	for _, point := range seen {
		result = append(result, point)
	}
	sort.Slice(result, func(a, b int) bool { return result[a].Before(result[b]) })
	return result
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a.UTC()
	}
	return b.UTC()
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a.UTC()
	}
	return b.UTC()
}
