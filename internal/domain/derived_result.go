package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// EstimationDifferenceRow is the audit form of one adjacent point pair. The
// row is retained even when Accepted is false.
type EstimationDifferenceRow struct {
	ID              string
	StartPointID    string
	EndPointID      string
	StartAt         time.Time
	EndAt           time.Time
	Coefficients    []float64
	Cost            float64
	Accepted        bool
	ExclusionReason string
}

type EstimationResultSeries struct {
	ID                    string
	UsageLimitSourceID    string
	LogicalAccountID      string
	PlanVersionID         string
	CalculationIntervalID string
	Multiplier            *float64
	EstimatedLimit        *float64
	PlanLimitRuleID       string
	PlanLimitRuleIDs      []string
}

type EstimationEvidence struct {
	ID                        string
	Kind                      string
	PointID                   string
	SourceID                  string
	ObservationID             string
	SnapshotID                string
	AssociationID             string
	CompletenessID            string
	PlanHistoryID             string
	LogicalAccountID          string
	PlanVersionID             string
	ObservedAt                time.Time
	TimeDelta                 time.Duration
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	DetailsJSON               string
}

// DerivedResult is the non-canonical, replaceable result set persisted by
// T-033. Points and intervals are included for evidence construction and are
// never treated as the source of truth.
type DerivedResult struct {
	ID                     string
	ResultSetKey           string
	ServiceID              string
	LimitDefinitionID      string
	CycleType              string
	CalculationIntervalIDs []string
	ValidFrom              time.Time
	ValidTo                time.Time
	InputFingerprint       string
	MatchingRuleVersion    string
	EstimationResult
	Points             []EstimationPoint
	Intervals          []CalculationInterval
	Series             []EstimationResultSeries
	Evidence           []EstimationEvidence
	DifferenceRowCount int
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// FallbackResult is a historical result usable when the current interval has
// no valid result. Age is deliberately retained without an expiry policy.
type FallbackResult struct {
	ResultID         string
	SeriesID         string
	LogicalAccountID string
	PlanVersionID    string
	ValidFrom        time.Time
	ValidTo          time.Time
	Age              time.Duration
	Status           EstimationStatus
}

type RecalculationRequest struct {
	RequestID     string
	AuditID       string
	RequestedAt   time.Time
	IntervalStart time.Time
	IntervalEnd   time.Time
	ScopeJSON     string
	State         string
	LastError     string
	ClaimedBy     string
	ClaimedAt     *time.Time
}

// RecalculationScope is the single JSON contract used to select calculation
// intervals for a recalculation request. An empty object is the unfiltered
// scope used by the migration default; producers encode all five arrays.
type RecalculationScope struct {
	ServiceIDs     []string `json:"serviceIDs"`
	DefinitionIDs  []string `json:"definitionIDs"`
	AccountIDs     []string `json:"accountIDs"`
	LimitSourceIDs []string `json:"sourceIDs"`
	CostSourceIDs  []string `json:"costSourceIDs"`
	IntervalIDs    []string `json:"intervalIDs"`
}

func (scope RecalculationScope) Validate() error {
	for field, values := range map[string][]string{
		"serviceIDs": scope.ServiceIDs, "definitionIDs": scope.DefinitionIDs,
		"accountIDs": scope.AccountIDs, "sourceIDs": scope.LimitSourceIDs,
		"costSourceIDs": scope.CostSourceIDs,
		"intervalIDs":   scope.IntervalIDs,
	} {
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				return fmt.Errorf("recalculation scope %s contains an empty ID", field)
			}
		}
	}
	return nil
}

func EncodeRecalculationScope(scope RecalculationScope) (string, error) {
	if err := scope.Validate(); err != nil {
		return "", err
	}
	scope.ServiceIDs = uniqueSorted(scope.ServiceIDs)
	scope.DefinitionIDs = uniqueSorted(scope.DefinitionIDs)
	scope.AccountIDs = uniqueSorted(scope.AccountIDs)
	scope.LimitSourceIDs = uniqueSorted(scope.LimitSourceIDs)
	scope.CostSourceIDs = uniqueSorted(scope.CostSourceIDs)
	scope.IntervalIDs = uniqueSorted(scope.IntervalIDs)
	encoded, err := json.Marshal(scope)
	if err != nil {
		return "", fmt.Errorf("encode recalculation scope: %w", err)
	}
	return string(encoded), nil
}

func DecodeRecalculationScope(encoded string) (RecalculationScope, error) {
	if strings.TrimSpace(encoded) == "" {
		encoded = "{}"
	}
	decoder := json.NewDecoder(strings.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var scope RecalculationScope
	if err := decoder.Decode(&scope); err != nil {
		return RecalculationScope{}, fmt.Errorf("decode recalculation scope: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return RecalculationScope{}, fmt.Errorf("decode recalculation scope: trailing JSON")
		}
		return RecalculationScope{}, fmt.Errorf("decode recalculation scope: %w", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &raw); err != nil {
		return RecalculationScope{}, fmt.Errorf("decode recalculation scope: %w", err)
	}
	if raw == nil {
		return RecalculationScope{}, errors.New("decode recalculation scope: expected an object")
	}
	for field, value := range raw {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return RecalculationScope{}, fmt.Errorf("decode recalculation scope: %s must be an array", field)
		}
	}
	if err := scope.Validate(); err != nil {
		return RecalculationScope{}, err
	}
	scope.ServiceIDs = uniqueSorted(scope.ServiceIDs)
	scope.DefinitionIDs = uniqueSorted(scope.DefinitionIDs)
	scope.AccountIDs = uniqueSorted(scope.AccountIDs)
	scope.LimitSourceIDs = uniqueSorted(scope.LimitSourceIDs)
	scope.CostSourceIDs = uniqueSorted(scope.CostSourceIDs)
	scope.IntervalIDs = uniqueSorted(scope.IntervalIDs)
	return scope, nil
}

// ResultSetKey excludes the logic version by design. Changing the logic
// replaces the current result for this exact input set.
func ResultSetKey(serviceID, definitionID, cycle string, from, to time.Time, intervalIDs []string) string {
	ids := uniqueSorted(intervalIDs)
	return strings.Join([]string{serviceID, definitionID, cycle, from.UTC().Format(time.RFC3339Nano), to.UTC().Format(time.RFC3339Nano), strings.Join(ids, ",")}, "|")
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

// BuildAdjacentDifferenceRows applies the same adjacent-row rules as the
// numerical engine while preserving rejected rows for evidence.
func BuildAdjacentDifferenceRows(points []EstimationPoint) []EstimationDifferenceRow {
	ordered := append([]EstimationPoint(nil), points...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].ReferenceAt.Equal(ordered[j].ReferenceAt) {
			return ordered[i].ID < ordered[j].ID
		}
		return ordered[i].ReferenceAt.Before(ordered[j].ReferenceAt)
	})
	rows := make([]EstimationDifferenceRow, 0, maxInt(0, len(ordered)-1))
	for i := 1; i < len(ordered); i++ {
		previous, current := ordered[i-1], ordered[i]
		row := EstimationDifferenceRow{
			ID:           fmt.Sprintf("difference:%s:%s", previous.ID, current.ID),
			StartPointID: previous.ID, EndPointID: current.ID,
			StartAt: previous.ReferenceAt.UTC(), EndAt: current.ReferenceAt.UTC(),
			Cost:     current.SharedCost - previous.SharedCost,
			Accepted: true,
		}
		if len(current.Utilization) != len(previous.Utilization) {
			row.Accepted, row.ExclusionReason = false, "target_set_mismatch"
		} else {
			row.Coefficients = make([]float64, len(current.Utilization))
			allZero := row.Cost == 0
			if !isFinite(row.Cost) {
				row.Accepted, row.ExclusionReason = false, "non_finite_value"
			}
			for column := range row.Coefficients {
				row.Coefficients[column] = current.Utilization[column] - previous.Utilization[column]
				if !isFinite(row.Coefficients[column]) && row.ExclusionReason == "" {
					row.Accepted, row.ExclusionReason = false, "non_finite_value"
				}
				if row.Coefficients[column] != 0 {
					allZero = false
				}
				if row.Coefficients[column] < 0 && row.ExclusionReason == "" {
					row.Accepted, row.ExclusionReason = false, "negative_utilization_delta"
				}
			}
			if row.Cost < 0 {
				row.Accepted, row.ExclusionReason = false, "negative_cost"
			} else if row.Accepted && allZero {
				row.Accepted, row.ExclusionReason = false, "zero_delta"
			}
		}
		rows = append(rows, row)
	}
	return rows
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// ComputeInputFingerprint hashes only input facts and rule versions. Slice
// order is canonicalized, so collection/query order cannot change it.
func ComputeInputFingerprint(points []EstimationPoint, rows []EstimationDifferenceRow, evidence []EstimationEvidence, multipliers []float64, ruleIDs []string, matchingVersion, logicVersion string, rules ...PlanLimitRule) (string, error) {
	type matchedFact struct {
		ID, Role, SourceID, AccountID, ObservationID, ObservedAt string
		TimeDelta, Tolerance                                     int64
		AnalyticsSeconds                                         int64
		SyncMS, RefreshMS                                        *int64
		Generation                                               int64
		Rule, Logic                                              string
	}
	type pointFact struct {
		ID, ServiceID, DefinitionID, Cycle, IntervalID, MatchingRule, Logic                                      string
		ReferenceAt                                                                                              string
		SharedCost                                                                                               float64
		Utilization                                                                                              []float64
		IntervalIDs, SeriesIDs, AccountIDs, PlanIDs, SeriesIntervalIDs, CostIDs, AssociationIDs, CompletenessIDs []string
		Matched                                                                                                  []matchedFact
	}
	type rowFact struct {
		ID, Start, End, StartAt, EndAt, Reason string
		Coefficients                           []float64
		Cost                                   float64
		Accepted                               bool
	}
	type evidenceFact struct {
		ID, Kind, PointID, SourceID, ObservationID, SnapshotID, AssociationID, CompletenessID, PlanHistoryID, AccountID, PlanVersionID, ObservedAt, Details string
		TimeDelta, Generation                                                                                                                               int64
		Rule, Logic                                                                                                                                         string
	}
	type ruleFact struct {
		ID, PlanVersionID, LimitDefinitionID, OfficialSourceURL string
		Limit, Multiplier                                       *float64
		CreatedAt                                               string
	}
	type fingerprintFact struct {
		Points                        []pointFact
		Rows                          []rowFact
		Evidence                      []evidenceFact
		Multipliers                   []float64
		RuleIDs                       []string
		MatchingVersion, LogicVersion string
		Rules                         []ruleFact
	}
	fact := fingerprintFact{Multipliers: append([]float64(nil), multipliers...), RuleIDs: uniqueSorted(ruleIDs), MatchingVersion: matchingVersion, LogicVersion: logicVersion}
	for _, rule := range rules {
		var limit, multiplier *float64
		if rule.Limit != nil {
			value := *rule.Limit
			limit = &value
		}
		if rule.Multiplier != nil {
			value := *rule.Multiplier
			multiplier = &value
		}
		fact.Rules = append(fact.Rules, ruleFact{ID: rule.ID, PlanVersionID: rule.PlanVersionID, LimitDefinitionID: rule.LimitDefinitionID, OfficialSourceURL: rule.OfficialSourceURL, Limit: limit, Multiplier: multiplier, CreatedAt: rule.CreatedAt.UTC().Format(time.RFC3339Nano)})
	}
	sort.Slice(fact.Rules, func(i, j int) bool { return fact.Rules[i].ID < fact.Rules[j].ID })
	for _, point := range points {
		pf := pointFact{ID: point.ID, ServiceID: point.ServiceID, DefinitionID: point.LimitDefinitionID, Cycle: point.CycleType, IntervalID: point.CalculationIntervalID, MatchingRule: point.MatchingRuleVersion, Logic: point.CalculationLogicVersion, ReferenceAt: point.ReferenceAt.UTC().Format(time.RFC3339Nano), SharedCost: point.SharedCost, Utilization: append([]float64(nil), point.Utilization...), IntervalIDs: uniqueSorted(point.CalculationIntervalIDs), SeriesIDs: append([]string(nil), point.LimitSeriesIDs...), AccountIDs: append([]string(nil), point.LimitSeriesLogicalAccountIDs...), PlanIDs: append([]string(nil), point.LimitSeriesPlanVersionIDs...), SeriesIntervalIDs: append([]string(nil), point.LimitSeriesCalculationIntervalIDs...), CostIDs: uniqueSorted(point.CostSourceIDs), AssociationIDs: uniqueSorted(point.AssociationIDs), CompletenessIDs: uniqueSorted(point.CompletenessIDs)}
		for _, item := range point.MatchedObservations {
			syncMS, refreshMS := clonePtr(item.SyncUploadIntervalMS), clonePtr(item.LimitsRefreshMS)
			pf.Matched = append(pf.Matched, matchedFact{ID: item.ID, Role: string(item.Role), SourceID: item.SourceID, AccountID: item.LogicalAccountID, ObservationID: item.ObservationID, ObservedAt: item.ObservedAt.UTC().Format(time.RFC3339Nano), TimeDelta: item.TimeDelta.Nanoseconds(), Tolerance: item.Tolerance.Nanoseconds(), AnalyticsSeconds: item.AnalyticsIntervalSeconds, SyncMS: syncMS, RefreshMS: refreshMS, Generation: item.NormalizationGeneration, Rule: item.NormalizationRuleVersion, Logic: item.NormalizationLogicVersion})
		}
		sort.Slice(pf.Matched, func(i, j int) bool { return pf.Matched[i].ID < pf.Matched[j].ID })
		fact.Points = append(fact.Points, pf)
	}
	sort.Slice(fact.Points, func(i, j int) bool { return fact.Points[i].ID < fact.Points[j].ID })
	for _, row := range rows {
		fact.Rows = append(fact.Rows, rowFact{ID: row.ID, Start: row.StartPointID, End: row.EndPointID, StartAt: row.StartAt.UTC().Format(time.RFC3339Nano), EndAt: row.EndAt.UTC().Format(time.RFC3339Nano), Reason: row.ExclusionReason, Coefficients: append([]float64(nil), row.Coefficients...), Cost: row.Cost, Accepted: row.Accepted})
	}
	sort.Slice(fact.Rows, func(i, j int) bool { return fact.Rows[i].ID < fact.Rows[j].ID })
	for _, item := range evidence {
		fact.Evidence = append(fact.Evidence, evidenceFact{ID: item.ID, Kind: item.Kind, PointID: item.PointID, SourceID: item.SourceID, ObservationID: item.ObservationID, SnapshotID: item.SnapshotID, AssociationID: item.AssociationID, CompletenessID: item.CompletenessID, PlanHistoryID: item.PlanHistoryID, AccountID: item.LogicalAccountID, PlanVersionID: item.PlanVersionID, ObservedAt: item.ObservedAt.UTC().Format(time.RFC3339Nano), Details: item.DetailsJSON, TimeDelta: item.TimeDelta.Nanoseconds(), Generation: item.NormalizationGeneration, Rule: item.NormalizationRuleVersion, Logic: item.NormalizationLogicVersion})
	}
	sort.Slice(fact.Evidence, func(i, j int) bool { return fact.Evidence[i].ID < fact.Evidence[j].ID })
	encoded, err := json.Marshal(fact)
	if err != nil {
		return "", fmt.Errorf("encode estimation input fingerprint: %w", err)
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

func clonePtr(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}
