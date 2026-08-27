package desktop

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

// EstimationReader is the read-only port used by the M03 Wails adapter.
type EstimationReader interface {
	ListCurrentLimitSeries(context.Context, time.Time) ([]domain.LimitSeriesView, error)
	ListEstimationResults(context.Context, string) ([]domain.DerivedResult, error)
	ListCalculationIntervalViews(context.Context, string, string, string, string) ([]domain.CalculationIntervalView, error)
	ListStandardPrices(context.Context, string) ([]domain.StandardPrice, error)
}

type EstimationService struct {
	reader EstimationReader
	clock  usecase.Clock
}

type LimitSeriesFilterInput struct {
	ServiceID         string `json:"serviceId"`
	Status            string `json:"status"`
	PlanVersionID     string `json:"planVersionId"`
	LimitDefinitionID string `json:"limitDefinitionId"`
	SortBy            string `json:"sortBy"`
	Descending        bool   `json:"descending"`
}

type LimitSeriesSnapshot struct {
	ID                             string                       `json:"id"`
	ServiceID                      string                       `json:"serviceId"`
	ServiceName                    string                       `json:"serviceName"`
	LogicalAccountID               string                       `json:"logicalAccountId"`
	LogicalAccountName             string                       `json:"logicalAccountName"`
	LimitDefinitionID              string                       `json:"limitDefinitionId"`
	LimitDefinitionName            string                       `json:"limitDefinitionName"`
	CycleType                      string                       `json:"cycleType"`
	BillingConfirmation            string                       `json:"billingConfirmation"`
	UsageLimitSourceID             string                       `json:"usageLimitSourceId"`
	AssociationID                  string                       `json:"associationId"`
	NormalizedKind                 string                       `json:"normalizedKind"`
	NormalizedMetric               string                       `json:"normalizedMetric"`
	PlanHistoryID                  string                       `json:"planHistoryId"`
	PlanVersionID                  string                       `json:"planVersionId"`
	PlanVersionName                string                       `json:"planVersionName"`
	PlanLimitRuleID                string                       `json:"planLimitRuleId"`
	PlanLimit                      *float64                     `json:"planLimit"`
	PlanLimitLabel                 string                       `json:"planLimitLabel"`
	Multiplier                     *float64                     `json:"multiplier"`
	UsedPercent                    *float64                     `json:"usedPercent"`
	UsedPercentLabel               string                       `json:"usedPercentLabel"`
	UsedPercentDetailLabel         string                       `json:"usedPercentDetailLabel"`
	RemainingPercent               *float64                     `json:"remainingPercent"`
	RemainingLabel                 string                       `json:"remainingLabel"`
	RemainingDetailLabel           string                       `json:"remainingDetailLabel"`
	ResetAt                        string                       `json:"resetAt"`
	LatestObservationAt            string                       `json:"latestObservationAt"`
	SeriesState                    string                       `json:"seriesState"`
	State                          StatusPresentationSnapshot   `json:"state"`
	StateReasonCode                string                       `json:"stateReasonCode"`
	StateReason                    string                       `json:"stateReason"`
	CurrentInterval                *CalculationIntervalSnapshot `json:"currentInterval"`
	Result                         *EstimationResultSnapshot    `json:"result"`
	LatestValidReference           *EstimationReferenceSnapshot `json:"latestValidReference"`
	EstimatedLimit                 *float64                     `json:"estimatedLimit"`
	EstimatedLimitLabel            string                       `json:"estimatedLimitLabel"`
	MonthlyEquivalentLimit         *float64                     `json:"monthlyEquivalentLimit"`
	MonthlyEquivalentLimitLabel    string                       `json:"monthlyEquivalentLimitLabel"`
	StandardPriceUSDMonthlyPerSeat *float64                     `json:"standardPriceUsdMonthlyPerSeat"`
	StandardPriceSourceURL         string                       `json:"standardPriceSourceUrl"`
	StandardPriceValidFrom         string                       `json:"standardPriceValidFrom"`
	StandardPriceValidTo           string                       `json:"standardPriceValidTo"`
	ValueMultiplier                *float64                     `json:"valueMultiplier"`
	ValueMultiplierLabel           string                       `json:"valueMultiplierLabel"`
	ValueReasonCode                string                       `json:"valueReasonCode"`
	ValueReason                    string                       `json:"valueReason"`
}

type CalculationIntervalSnapshot struct {
	ID                             string                        `json:"id"`
	ServiceID                      string                        `json:"serviceId"`
	LogicalAccountID               string                        `json:"logicalAccountId"`
	UsageLimitSourceID             string                        `json:"usageLimitSourceId"`
	LimitDefinitionID              string                        `json:"limitDefinitionId"`
	PlanVersionID                  string                        `json:"planVersionId"`
	CycleType                      string                        `json:"cycleType"`
	ValidFrom                      string                        `json:"validFrom"`
	ValidTo                        string                        `json:"validTo"`
	State                          string                        `json:"state"`
	StateLabel                     string                        `json:"stateLabel"`
	ExclusionReasonCode            string                        `json:"exclusionReasonCode"`
	ExclusionReason                string                        `json:"exclusionReason"`
	BoundaryIDs                    []string                      `json:"boundaryIds"`
	Boundaries                     []CalculationBoundarySnapshot `json:"boundaries"`
	Role                           string                        `json:"role"`
	RoleLabel                      string                        `json:"roleLabel"`
	EstimatedLimit                 *float64                      `json:"estimatedLimit"`
	EstimatedLimitLabel            string                        `json:"estimatedLimitLabel"`
	MonthlyEquivalentLimit         *float64                      `json:"monthlyEquivalentLimit"`
	MonthlyEquivalentLimitLabel    string                        `json:"monthlyEquivalentLimitLabel"`
	StandardPriceUSDMonthlyPerSeat *float64                      `json:"standardPriceUsdMonthlyPerSeat"`
	StandardPriceSourceURL         string                        `json:"standardPriceSourceUrl"`
	StandardPriceValidFrom         string                        `json:"standardPriceValidFrom"`
	StandardPriceValidTo           string                        `json:"standardPriceValidTo"`
	ValueMultiplier                *float64                      `json:"valueMultiplier"`
	ValueMultiplierLabel           string                        `json:"valueMultiplierLabel"`
	ValueReasonCode                string                        `json:"valueReasonCode"`
	ValueReason                    string                        `json:"valueReason"`
}

type CalculationBoundarySnapshot struct {
	ID        string `json:"id"`
	KindCode  string `json:"kindCode"`
	Kind      string `json:"kind"`
	At        string `json:"at"`
	Reason    string `json:"reason"`
	RelatedID string `json:"relatedId"`
}

type EstimationResultSnapshot struct {
	ID                      string                            `json:"id"`
	ResultSetKey            string                            `json:"resultSetKey"`
	Status                  StatusPresentationSnapshot        `json:"status"`
	StatusReasonCode        string                            `json:"statusReasonCode"`
	StatusReason            string                            `json:"statusReason"`
	Limits                  []float64                         `json:"limits"`
	ObservationPointCount   int                               `json:"observationPointCount"`
	DifferenceRowCount      int                               `json:"differenceRowCount"`
	Rank                    int                               `json:"rank"`
	AbsoluteErrorRatio      float64                           `json:"absoluteErrorRatio"`
	AbsoluteErrorRatioLabel string                            `json:"absoluteErrorRatioLabel"`
	MaxTimeDelta            string                            `json:"maxTimeDelta"`
	CalculationLogicVersion string                            `json:"calculationLogicVersion"`
	MatchingRuleVersion     string                            `json:"matchingRuleVersion"`
	InputFingerprint        string                            `json:"inputFingerprint"`
	CalculationIntervalIDs  []string                          `json:"calculationIntervalIds"`
	ValidFrom               string                            `json:"validFrom"`
	ValidTo                 string                            `json:"validTo"`
	DifferenceRows          []EstimationDifferenceRowSnapshot `json:"differenceRows"`
	Evidence                []EstimationEvidenceSnapshot      `json:"evidence"`
}

type EstimationReferenceSnapshot struct {
	ResultID   string                     `json:"resultId"`
	Status     StatusPresentationSnapshot `json:"status"`
	ValidFrom  string                     `json:"validFrom"`
	ValidTo    string                     `json:"validTo"`
	Age        string                     `json:"age"`
	ObservedAt string                     `json:"observedAt"`
}

type EstimationDifferenceRowSnapshot struct {
	ID                  string    `json:"id"`
	StartPointID        string    `json:"startPointId"`
	EndPointID          string    `json:"endPointId"`
	StartAt             string    `json:"startAt"`
	EndAt               string    `json:"endAt"`
	Coefficients        []float64 `json:"coefficients"`
	Cost                float64   `json:"cost"`
	Accepted            bool      `json:"accepted"`
	ExclusionReasonCode string    `json:"exclusionReasonCode"`
	ExclusionReason     string    `json:"exclusionReason"`
}

type EstimationEvidenceSnapshot struct {
	ID                        string `json:"id"`
	Kind                      string `json:"kind"`
	PointID                   string `json:"pointId"`
	SourceID                  string `json:"sourceId"`
	ObservationID             string `json:"observationId"`
	SnapshotID                string `json:"snapshotId"`
	AssociationID             string `json:"associationId"`
	CompletenessID            string `json:"completenessId"`
	PlanHistoryID             string `json:"planHistoryId"`
	LogicalAccountID          string `json:"logicalAccountId"`
	PlanVersionID             string `json:"planVersionId"`
	ObservedAt                string `json:"observedAt"`
	TimeDelta                 string `json:"timeDelta"`
	NormalizationGeneration   int64  `json:"normalizationGeneration"`
	NormalizationRuleVersion  string `json:"normalizationRuleVersion"`
	NormalizationLogicVersion string `json:"normalizationLogicVersion"`
	DetailsJSON               string `json:"detailsJson"`
	M08Route                  string `json:"m08Route"`
}

type LimitSeriesDetailSnapshot struct {
	Series  LimitSeriesSnapshot           `json:"series"`
	Current *CalculationIntervalSnapshot  `json:"current"`
	History []CalculationIntervalSnapshot `json:"history"`
}

func NewEstimationService(reader EstimationReader) (*EstimationService, error) {
	if reader == nil {
		return nil, errors.New("estimation service lifecycle is required")
	}
	return NewEstimationServiceWithDependencies(reader, usecase.SystemClock{})
}

func NewEstimationServiceWithDependencies(reader EstimationReader, clock usecase.Clock) (*EstimationService, error) {
	if reader == nil || clock == nil {
		return nil, errors.New("estimation service dependencies are required")
	}
	return &EstimationService{reader: reader, clock: clock}, nil
}

func (s *EstimationService) GetLimitSeries(ctx context.Context, input LimitSeriesFilterInput) ([]LimitSeriesSnapshot, error) {
	if s == nil || s.reader == nil || s.clock == nil {
		return nil, errors.New("estimation service is unavailable")
	}
	now := s.clock.Now().UTC()
	rows, err := s.reader.ListCurrentLimitSeries(ctx, now)
	if err != nil {
		return nil, err
	}
	results, err := s.resultsByService(ctx, rows)
	if err != nil {
		return nil, err
	}
	prices, err := s.standardPricesByPlanVersion(ctx, rows)
	if err != nil {
		return nil, err
	}
	items := make([]LimitSeriesSnapshot, 0, len(rows))
	for _, row := range rows {
		result := resultForSeries(row, results[row.ServiceID])
		reference := fallbackForSeries(row, results[row.ServiceID], now, result)
		state, reason := deriveLimitState(row, result)
		if input.ServiceID != "" && row.ServiceID != input.ServiceID || input.PlanVersionID != "" && row.PlanVersionID != input.PlanVersionID || input.LimitDefinitionID != "" && row.LimitDefinitionID != input.LimitDefinitionID || input.Status != "" && string(state) != input.Status {
			continue
		}
		items = append(items, limitSeriesSnapshot(row, state, reason, result, reference, prices[row.PlanVersionID], now))
	}
	sortLimitSeries(items, input.SortBy, input.Descending)
	return items, nil
}

func (s *EstimationService) standardPricesByPlanVersion(ctx context.Context, rows []domain.LimitSeriesView) (map[string][]domain.StandardPrice, error) {
	prices := make(map[string][]domain.StandardPrice)
	for _, row := range rows {
		if row.PlanVersionID == "" {
			continue
		}
		if _, ok := prices[row.PlanVersionID]; ok {
			continue
		}
		items, err := s.reader.ListStandardPrices(ctx, row.PlanVersionID)
		if err != nil {
			return nil, err
		}
		prices[row.PlanVersionID] = items
	}
	return prices, nil
}

func (s *EstimationService) GetLimitSeriesDetail(ctx context.Context, seriesID string) (LimitSeriesDetailSnapshot, error) {
	if strings.TrimSpace(seriesID) == "" {
		return LimitSeriesDetailSnapshot{}, errors.New("limit series ID is required")
	}
	items, err := s.GetLimitSeries(ctx, LimitSeriesFilterInput{})
	if err != nil {
		return LimitSeriesDetailSnapshot{}, err
	}
	for _, item := range items {
		if item.ID != seriesID {
			continue
		}
		history, err := s.reader.ListCalculationIntervalViews(ctx, item.ServiceID, item.LogicalAccountID, item.LimitDefinitionID, item.UsageLimitSourceID)
		if err != nil {
			return LimitSeriesDetailSnapshot{}, err
		}
		results, err := s.reader.ListEstimationResults(ctx, item.ServiceID)
		if err != nil {
			return LimitSeriesDetailSnapshot{}, err
		}
		prices, err := s.standardPricesByIntervals(ctx, history)
		if err != nil {
			return LimitSeriesDetailSnapshot{}, err
		}
		detail := LimitSeriesDetailSnapshot{Series: item, Current: item.CurrentInterval, History: make([]CalculationIntervalSnapshot, 0, len(history))}
		for _, interval := range history {
			snapshot := calculationIntervalSnapshot(interval)
			applyIntervalValue(&snapshot, interval, item, results, prices[interval.PlanVersionID])
			snapshot.Role, snapshot.RoleLabel = intervalRole(interval, item)
			detail.History = append(detail.History, snapshot)
			if item.CurrentInterval != nil && item.CurrentInterval.ID == interval.ID {
				current := snapshot
				detail.Current = &current
			}
		}
		return detail, nil
	}
	return LimitSeriesDetailSnapshot{}, errors.New("limit series was not found")
}

func (s *EstimationService) standardPricesByIntervals(ctx context.Context, intervals []domain.CalculationIntervalView) (map[string][]domain.StandardPrice, error) {
	prices := make(map[string][]domain.StandardPrice)
	for _, interval := range intervals {
		if interval.PlanVersionID == "" {
			continue
		}
		if _, ok := prices[interval.PlanVersionID]; ok {
			continue
		}
		items, err := s.reader.ListStandardPrices(ctx, interval.PlanVersionID)
		if err != nil {
			return nil, err
		}
		prices[interval.PlanVersionID] = items
	}
	return prices, nil
}

func intervalRole(interval domain.CalculationIntervalView, item LimitSeriesSnapshot) (string, string) {
	if item.CurrentInterval != nil && interval.ID == item.CurrentInterval.ID {
		return "current", "カレント"
	}
	if item.LatestValidReference != nil {
		validFrom, fromErr := time.Parse(time.RFC3339Nano, item.LatestValidReference.ValidFrom)
		validTo, toErr := time.Parse(time.RFC3339Nano, item.LatestValidReference.ValidTo)
		if fromErr == nil && toErr == nil && interval.ValidFrom.Equal(validFrom) && interval.ValidTo.Equal(validTo) {
			return "latest_valid_reference", "最新有効参照"
		}
	}
	return "noncurrent", "非カレント"
}

func applyIntervalValue(snapshot *CalculationIntervalSnapshot, interval domain.CalculationIntervalView, item LimitSeriesSnapshot, results []domain.DerivedResult, prices []domain.StandardPrice) {
	if snapshot == nil {
		return
	}
	var estimatedLimit *float64
	for resultIndex := range results {
		result := &results[resultIndex]
		if result.Status != domain.EstimationProvisional && result.Status != domain.EstimationVerified {
			continue
		}
		containsInterval := false
		for _, intervalID := range result.CalculationIntervalIDs {
			if intervalID == interval.ID {
				containsInterval = true
				break
			}
		}
		if !containsInterval {
			continue
		}
		for seriesIndex := range result.Series {
			series := &result.Series[seriesIndex]
			if series.UsageLimitSourceID == item.UsageLimitSourceID && series.LogicalAccountID == item.LogicalAccountID && series.PlanVersionID == interval.PlanVersionID && series.EstimatedLimit != nil {
				value := *series.EstimatedLimit
				estimatedLimit = &value
				break
			}
		}
		if estimatedLimit != nil {
			break
		}
	}
	calculation := domain.CalculateValue(domain.ValueCalculationInput{
		CycleType: interval.CycleType, BillingConfirmation: domain.BillingConfirmation(item.BillingConfirmation), Metric: item.NormalizedMetric,
		EstimatedLimit: estimatedLimit, At: interval.ValidFrom, StandardPrice: standardPriceAt(prices, interval.ValidFrom),
	})
	if estimatedLimit != nil {
		snapshot.EstimatedLimit = estimatedLimit
		snapshot.EstimatedLimitLabel = formatNumber(estimatedLimit, 2)
	}
	if calculation.MonthlyEquivalent != nil {
		snapshot.MonthlyEquivalentLimit = calculation.MonthlyEquivalent
		snapshot.MonthlyEquivalentLimitLabel = formatNumber(calculation.MonthlyEquivalent, 2)
	}
	if calculation.StandardPrice != nil {
		snapshot.StandardPriceUSDMonthlyPerSeat = &calculation.StandardPrice.USDMonthlyPerSeat
		snapshot.StandardPriceSourceURL = calculation.StandardPrice.SourceURL
		snapshot.StandardPriceValidFrom = calculation.StandardPrice.ValidFrom.UTC().Format(time.RFC3339Nano)
		if calculation.StandardPrice.ValidTo != nil {
			snapshot.StandardPriceValidTo = calculation.StandardPrice.ValidTo.UTC().Format(time.RFC3339Nano)
		}
	}
	if calculation.ValueMultiplier != nil {
		snapshot.ValueMultiplier = calculation.ValueMultiplier
		snapshot.ValueMultiplierLabel = formatNumber(calculation.ValueMultiplier, 2) + "×"
	}
	snapshot.ValueReasonCode = string(calculation.Reason)
	snapshot.ValueReason = valueReasonLabel(calculation.Reason)
}

func (s *EstimationService) resultsByService(ctx context.Context, rows []domain.LimitSeriesView) (map[string][]domain.DerivedResult, error) {
	services := map[string]struct{}{}
	for _, row := range rows {
		services[row.ServiceID] = struct{}{}
	}
	result := make(map[string][]domain.DerivedResult, len(services))
	for serviceID := range services {
		items, err := s.reader.ListEstimationResults(ctx, serviceID)
		if err != nil {
			return nil, err
		}
		result[serviceID] = items
	}
	return result, nil
}

func resultForSeries(row domain.LimitSeriesView, results []domain.DerivedResult) *domain.DerivedResult {
	if row.Interval == nil {
		return nil
	}
	for index := range results {
		result := &results[index]
		for _, intervalID := range result.CalculationIntervalIDs {
			if intervalID != row.Interval.ID {
				continue
			}
			for _, series := range result.Series {
				if series.UsageLimitSourceID == row.UsageLimitSourceID && series.LogicalAccountID == row.LogicalAccountID && series.PlanVersionID == row.PlanVersionID {
					return result
				}
			}
		}
	}
	return nil
}

func deriveLimitState(row domain.LimitSeriesView, result *domain.DerivedResult) (domain.EstimationStatus, string) {
	if row.NormalizedMetric != "percent" || (row.CycleType != "weekly" && row.CycleType != "billing") {
		return domain.EstimationNotApplicable, "window_not_supported"
	}
	if row.PlanVersionID == "" || row.PlanLimitRuleID == "" {
		return domain.EstimationUncomputed, "missing_plan_limit_rule"
	}
	if row.Interval == nil {
		return domain.EstimationUncomputed, "calculation_interval_not_available"
	}
	if row.LatestObservationAt == nil || row.UsedPercent == nil {
		return domain.EstimationInsufficient, "insufficient_observations"
	}
	if result == nil {
		return domain.EstimationUncomputed, "result_not_available"
	}
	reason := ""
	if len(result.Reasons) > 0 {
		reason = result.Reasons[0]
	}
	return result.Status, reason
}

func limitSeriesSnapshot(row domain.LimitSeriesView, state domain.EstimationStatus, reason string, result *domain.DerivedResult, reference *EstimationReferenceSnapshot, prices []domain.StandardPrice, at time.Time) LimitSeriesSnapshot {
	item := LimitSeriesSnapshot{
		ID: row.ID, ServiceID: row.ServiceID, ServiceName: row.ServiceName,
		LogicalAccountID: row.LogicalAccountID, LogicalAccountName: row.LogicalAccountName,
		LimitDefinitionID: row.LimitDefinitionID, LimitDefinitionName: row.LimitDefinitionName,
		CycleType: row.CycleType, BillingConfirmation: string(row.BillingConfirmation), UsageLimitSourceID: row.UsageLimitSourceID, AssociationID: row.AssociationID,
		NormalizedKind: row.NormalizedKind, NormalizedMetric: row.NormalizedMetric,
		PlanHistoryID: row.PlanHistoryID, PlanVersionID: row.PlanVersionID, PlanVersionName: row.PlanVersionName,
		PlanLimitRuleID: row.PlanLimitRuleID, PlanLimit: row.PlanLimit, Multiplier: row.Multiplier,
		UsedPercent: row.UsedPercent, RemainingPercent: row.RemainingPercent,
		PlanLimitLabel: formatNumber(row.PlanLimit, 2), UsedPercentLabel: formatNumber(row.UsedPercent, 1), UsedPercentDetailLabel: formatNumber(row.UsedPercent, 2), RemainingLabel: formatRemaining(row.RemainingPercent, 1), RemainingDetailLabel: formatRemaining(row.RemainingPercent, 2),
		ResetAt: formatOptionalTime(row.ResetAt), LatestObservationAt: formatOptionalTime(row.LatestObservationAt),
		SeriesState: row.SeriesState, StateReasonCode: reason, StateReason: estimationReasonLabel(reason), CurrentInterval: intervalSnapshotPtr(row.Interval), LatestValidReference: reference,
	}
	item.State, _ = statusPresentation(string(state))
	if result != nil {
		item.Result = estimationResultSnapshot(result)
		if state == domain.EstimationProvisional || state == domain.EstimationVerified {
			for _, series := range result.Series {
				if series.UsageLimitSourceID == row.UsageLimitSourceID && series.LogicalAccountID == row.LogicalAccountID && series.PlanVersionID == row.PlanVersionID {
					item.EstimatedLimit = series.EstimatedLimit
					item.EstimatedLimitLabel = formatNumber(series.EstimatedLimit, 2)
					break
				}
			}
		}
	}
	var estimatedLimit *float64
	if item.EstimatedLimit != nil {
		value := *item.EstimatedLimit
		estimatedLimit = &value
	}
	price := standardPriceAt(prices, at)
	calculation := domain.CalculateValue(domain.ValueCalculationInput{
		CycleType: row.CycleType, BillingConfirmation: row.BillingConfirmation, Metric: row.NormalizedMetric,
		EstimatedLimit: estimatedLimit, At: at, StandardPrice: price,
	})
	if calculation.MonthlyEquivalent != nil {
		item.MonthlyEquivalentLimit = calculation.MonthlyEquivalent
		item.MonthlyEquivalentLimitLabel = formatNumber(calculation.MonthlyEquivalent, 2)
	}
	if calculation.StandardPrice != nil {
		item.StandardPriceUSDMonthlyPerSeat = &calculation.StandardPrice.USDMonthlyPerSeat
		item.StandardPriceSourceURL = calculation.StandardPrice.SourceURL
		item.StandardPriceValidFrom = calculation.StandardPrice.ValidFrom.UTC().Format(time.RFC3339Nano)
		if calculation.StandardPrice.ValidTo != nil {
			item.StandardPriceValidTo = calculation.StandardPrice.ValidTo.UTC().Format(time.RFC3339Nano)
		}
	}
	if calculation.ValueMultiplier != nil {
		item.ValueMultiplier = calculation.ValueMultiplier
		item.ValueMultiplierLabel = formatNumber(calculation.ValueMultiplier, 2) + "×"
	}
	item.ValueReasonCode = string(calculation.Reason)
	item.ValueReason = valueReasonLabel(calculation.Reason)
	return item
}

func standardPriceAt(prices []domain.StandardPrice, at time.Time) *domain.StandardPrice {
	instant := at.UTC()
	for index := range prices {
		price := prices[index]
		if instant.Before(price.ValidFrom.UTC()) || price.ValidTo != nil && !instant.Before(price.ValidTo.UTC()) {
			continue
		}
		return &price
	}
	return nil
}

func valueReasonLabel(reason domain.ValueReason) string {
	switch reason {
	case domain.ValueReasonComputed:
		return "算出済み"
	case domain.ValueReasonEstimateMissing:
		return "一周期当たりの推定利用上限がありません。"
	case domain.ValueReasonBillingUnconfirmed:
		return "月次 billing であることが未確認です。"
	case domain.ValueReasonMetricUnsupported:
		return "credits または spend は価値計算の対象外です。"
	case domain.ValueReasonCycleUnsupported:
		return "この利用周期は価値計算の対象外です。"
	case domain.ValueReasonInvalidEstimate:
		return "推定利用上限が不正です。"
	case domain.ValueReasonStandardPriceMissing:
		return "有効な標準価格がありません。"
	case domain.ValueReasonStandardPriceInvalid:
		return "標準価格が不正または有効期間外です。"
	default:
		return "価値倍率を算出できません。"
	}
}

func estimationReasonLabel(code string) string {
	labels := map[string]string{
		"window_not_supported":               "利用周期または単位が推定対象外です。",
		"missing_plan_limit_rule":            "適用中のプラン利用上限が未登録です。",
		"calculation_interval_not_available": "カレント計算区間がありません。",
		"insufficient_observations":          "同一計算区間の有効観測が不足しています。",
		"result_not_available":               "カレント区間の推定結果がまだありません。",
		"no_valid_differences":               "有効な隣接差分行がありません。",
		"insufficient_differences":           "推定に必要な差分行が不足しています。",
		"rank_deficient":                     "差分行の独立性が不足しています。",
		"zero_cost_signal":                   "利用額の変化がなく識別できません。",
		"exactly_identified":                 "必要最小限の差分行で暫定推定しました。",
		"residual_within_ten_percent":        "余分な差分行を許容誤差内で説明できました。",
		"residual_over_ten_percent":          "差分行の誤差が許容範囲を超えています。",
		"non_positive_solution":              "正の利用上限を得られませんでした。",
		"target_set_mismatch":                "計算対象集合が一致しません。",
		"non_finite_value":                   "有限な数値でない観測を含みます。",
		"negative_utilization_delta":         "利用率が減少した隣接行です。",
	}
	if label, ok := labels[code]; ok {
		return label
	}
	if code == "" {
		return "理由はありません。"
	}
	return "推定根拠を確認してください。"
}

func formatNumber(value *float64, decimals int) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%.*f", decimals, *value)
}

func formatRemaining(value *float64, decimals int) string {
	if value == nil {
		return ""
	}
	return fmt.Sprintf("%.*f%%", decimals, *value)
}

func fallbackForSeries(row domain.LimitSeriesView, results []domain.DerivedResult, now time.Time, current *domain.DerivedResult) *EstimationReferenceSnapshot {
	if current != nil || row.PlanVersionID == "" {
		return nil
	}
	cutoff := now
	if row.Interval != nil {
		cutoff = row.Interval.ValidFrom
	}
	var selected *domain.DerivedResult
	for index := range results {
		candidate := &results[index]
		if candidate.LimitDefinitionID != row.LimitDefinitionID || candidate.CycleType != row.CycleType || candidate.ValidTo.After(cutoff) || (candidate.Status != domain.EstimationProvisional && candidate.Status != domain.EstimationVerified) {
			continue
		}
		matched := false
		for _, series := range candidate.Series {
			if series.UsageLimitSourceID == row.UsageLimitSourceID && series.LogicalAccountID == row.LogicalAccountID && series.PlanVersionID == row.PlanVersionID {
				matched = true
				break
			}
		}
		if !matched || (selected != nil && !selected.ValidTo.Before(candidate.ValidTo)) {
			continue
		}
		selected = candidate
	}
	if selected == nil {
		return nil
	}
	status, _ := statusPresentation(string(selected.Status))
	var observed time.Time
	for _, evidence := range selected.Evidence {
		if evidence.ObservedAt.After(observed) {
			observed = evidence.ObservedAt
		}
	}
	return &EstimationReferenceSnapshot{ResultID: selected.ID, Status: status, ValidFrom: selected.ValidFrom.UTC().Format(time.RFC3339Nano), ValidTo: selected.ValidTo.UTC().Format(time.RFC3339Nano), Age: now.Sub(selected.ValidTo).String(), ObservedAt: formatOptionalTime(nonZeroTime(observed))}
}

func estimationResultSnapshot(result *domain.DerivedResult) *EstimationResultSnapshot {
	if result == nil {
		return nil
	}
	state, _ := statusPresentation(string(result.Status))
	reason := ""
	if len(result.Reasons) > 0 {
		reason = result.Reasons[0]
	}
	item := &EstimationResultSnapshot{
		ID: result.ID, ResultSetKey: result.ResultSetKey, Status: state, StatusReasonCode: reason, StatusReason: estimationReasonLabel(reason),
		Limits: append([]float64(nil), result.Limits...), ObservationPointCount: result.Rows,
		DifferenceRowCount: result.DifferenceRowCount, Rank: result.Rank, AbsoluteErrorRatio: result.AbsoluteErrorRatio, AbsoluteErrorRatioLabel: fmt.Sprintf("%.2f%%", result.AbsoluteErrorRatio*100),
		MaxTimeDelta: result.MaxTimeDelta.String(), CalculationLogicVersion: result.CalculationLogicVersion,
		MatchingRuleVersion: result.MatchingRuleVersion, InputFingerprint: result.InputFingerprint,
		CalculationIntervalIDs: append([]string(nil), result.CalculationIntervalIDs...),
		ValidFrom:              result.ValidFrom.UTC().Format(time.RFC3339Nano), ValidTo: result.ValidTo.UTC().Format(time.RFC3339Nano),
		DifferenceRows: make([]EstimationDifferenceRowSnapshot, 0, len(result.DifferenceRows)), Evidence: make([]EstimationEvidenceSnapshot, 0, len(result.Evidence)),
	}
	for _, row := range result.DifferenceRows {
		item.DifferenceRows = append(item.DifferenceRows, EstimationDifferenceRowSnapshot{ID: row.ID, StartPointID: row.StartPointID, EndPointID: row.EndPointID, StartAt: row.StartAt.UTC().Format(time.RFC3339Nano), EndAt: row.EndAt.UTC().Format(time.RFC3339Nano), Coefficients: append([]float64(nil), row.Coefficients...), Cost: row.Cost, Accepted: row.Accepted, ExclusionReasonCode: row.ExclusionReason, ExclusionReason: estimationReasonLabel(row.ExclusionReason)})
	}
	for _, evidence := range result.Evidence {
		item.Evidence = append(item.Evidence, estimationEvidenceSnapshot(evidence))
	}
	return item
}

func estimationEvidenceSnapshot(value domain.EstimationEvidence) EstimationEvidenceSnapshot {
	route := "/evidence"
	if value.ObservationID != "" {
		route += "?observationId=" + value.ObservationID
	} else if value.SnapshotID != "" {
		route += "?snapshotId=" + value.SnapshotID
	}
	return EstimationEvidenceSnapshot{ID: value.ID, Kind: value.Kind, PointID: value.PointID, SourceID: value.SourceID, ObservationID: value.ObservationID, SnapshotID: value.SnapshotID, AssociationID: value.AssociationID, CompletenessID: value.CompletenessID, PlanHistoryID: value.PlanHistoryID, LogicalAccountID: value.LogicalAccountID, PlanVersionID: value.PlanVersionID, ObservedAt: formatOptionalTime(nonZeroTime(value.ObservedAt)), TimeDelta: value.TimeDelta.String(), NormalizationGeneration: value.NormalizationGeneration, NormalizationRuleVersion: value.NormalizationRuleVersion, NormalizationLogicVersion: value.NormalizationLogicVersion, DetailsJSON: value.DetailsJSON, M08Route: route}
}

func nonZeroTime(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}

func calculationIntervalSnapshot(value domain.CalculationIntervalView) CalculationIntervalSnapshot {
	stateLabel := map[string]string{"estimable": "推定可能", "excluded": "対象外"}[value.State]
	if stateLabel == "" {
		stateLabel = "不明"
	}
	item := CalculationIntervalSnapshot{ID: value.ID, ServiceID: value.ServiceID, LogicalAccountID: value.LogicalAccountID, UsageLimitSourceID: value.UsageLimitSourceID, LimitDefinitionID: value.LimitDefinitionID, PlanVersionID: value.PlanVersionID, CycleType: value.CycleType, ValidFrom: value.ValidFrom.UTC().Format(time.RFC3339Nano), ValidTo: value.ValidTo.UTC().Format(time.RFC3339Nano), State: value.State, StateLabel: stateLabel, ExclusionReasonCode: value.ExclusionReason, ExclusionReason: estimationReasonLabel(value.ExclusionReason), BoundaryIDs: append([]string(nil), value.BoundaryIDs...), Boundaries: make([]CalculationBoundarySnapshot, 0, len(value.Boundaries))}
	for _, boundary := range value.Boundaries {
		item.Boundaries = append(item.Boundaries, CalculationBoundarySnapshot{ID: boundary.ID, KindCode: boundary.Kind, Kind: boundaryKindLabel(boundary.Kind), At: boundary.At.UTC().Format(time.RFC3339Nano), Reason: estimationReasonLabel(boundary.Reason), RelatedID: boundary.RelatedID})
	}
	return item
}

func boundaryKindLabel(code string) string {
	labels := map[string]string{"reset": "リセット", "plan_history": "プラン履歴", "association": "関連付け", "completeness": "完全性", "hub_switch": "Hub切替", "api_contract": "API契約", "unexplained_decrease": "説明されない減少"}
	if value, ok := labels[code]; ok {
		return value
	}
	return "境界"
}

func intervalSnapshotPtr(value *domain.CalculationIntervalView) *CalculationIntervalSnapshot {
	if value == nil {
		return nil
	}
	result := calculationIntervalSnapshot(*value)
	return &result
}

func formatOptionalTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func sortLimitSeries(items []LimitSeriesSnapshot, sortBy string, descending bool) {
	if sortBy == "" {
		sortBy = "status"
	}
	sort.SliceStable(items, func(i, j int) bool {
		left, right := items[i], items[j]
		less := limitSeriesLess(left, right, sortBy)
		greater := limitSeriesLess(right, left, sortBy)
		if less {
			return !descending
		}
		if greater {
			return descending
		}
		return left.ID < right.ID
	})
}

func limitSeriesLess(left, right LimitSeriesSnapshot, sortBy string) bool {
	switch sortBy {
	case "remainingPercent":
		return nullableFloatLess(left.RemainingPercent, right.RemainingPercent)
	case "latestObservationAt":
		return nullableStringLess(left.LatestObservationAt, right.LatestObservationAt)
	default:
		statusOrder := map[string]int{"not_applicable": 0, "uncomputed": 1, "insufficient_observations": 2, "unidentifiable": 3, "model_mismatch": 4, "provisional": 5, "verified": 6}
		return statusOrder[left.State.Code] < statusOrder[right.State.Code]
	}
}

func nullableFloatLess(left, right *float64) bool {
	if left == nil || right == nil {
		return left != nil && right == nil
	}
	return *left < *right
}

func nullableStringLess(left, right string) bool {
	if left == "" || right == "" {
		return left != "" && right == ""
	}
	return left < right
}
