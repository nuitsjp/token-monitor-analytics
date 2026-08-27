package desktop

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	timezoneadapter "token-monitor-analytics/internal/adapter/timezone"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

const usageExportSchemaVersion = "2"

type UsageReader interface {
	ListUsageAnalysisObservations(context.Context) ([]domain.UsageObservation, error)
	ListUsageNativeAmounts(context.Context) ([]sqliteadapter.UsageNativeAmount, error)
}

type UsageService struct {
	reader UsageReader
	clock  usecase.Clock
}

type UsageFilterInput struct {
	From                 string `json:"from"`
	To                   string `json:"to"`
	DisplayTimeZone      string `json:"displayTimeZone"`
	Granularity          string `json:"granularity"`
	GroupBy              string `json:"groupBy"`
	HubID                string `json:"hubId"`
	CollectionDeviceID   string `json:"collectionDeviceId"`
	DeviceID             string `json:"deviceId"`
	ServiceID            string `json:"serviceId"`
	RawServiceIdentifier string `json:"rawServiceIdentifier"`
	LogicalAccountID     string `json:"logicalAccountId"`
	PlanVersionID        string `json:"planVersionId"`
	LimitDefinitionID    string `json:"limitDefinitionId"`
	Model                string `json:"model"`
}

type UsageSummarySnapshot struct {
	Tokens               int64   `json:"tokens"`
	SharedTokens         int64   `json:"sharedTokens"`
	APICostUSD           float64 `json:"apiCostUsd"`
	SharedAPICostUSD     float64 `json:"sharedApiCostUsd"`
	APICostUSDText       string  `json:"apiCostUsdText"`
	SharedAPICostUSDText string  `json:"sharedApiCostUsdText"`
	SourceCount          int     `json:"sourceCount"`
	ObservationCount     int     `json:"observationCount"`
}

type UsagePointSnapshot struct {
	PeriodStart          string                   `json:"periodStart"`
	PeriodEnd            string                   `json:"periodEnd"`
	Tokens               int64                    `json:"tokens"`
	SharedTokens         int64                    `json:"sharedTokens"`
	APICostUSD           float64                  `json:"apiCostUsd"`
	SharedAPICostUSD     float64                  `json:"sharedApiCostUsd"`
	APICostUSDText       string                   `json:"apiCostUsdText"`
	SharedAPICostUSDText string                   `json:"sharedApiCostUsdText"`
	ObservationCount     int                      `json:"observationCount"`
	Breakdown            []UsageBreakdownSnapshot `json:"breakdown"`
}

type UsageBreakdownSnapshot struct {
	Key              string  `json:"key"`
	CategoryKey      string  `json:"categoryKey"`
	Label            string  `json:"label"`
	Attribution      string  `json:"attribution"`
	Tokens           int64   `json:"tokens"`
	APICostUSD       float64 `json:"apiCostUsd"`
	APICostUSDText   string  `json:"apiCostUsdText"`
	ObservationCount int     `json:"observationCount"`
	EvidenceRoute    string  `json:"evidenceRoute"`
}

type UsageEvidenceSnapshot struct {
	SourceID             string `json:"sourceId"`
	StartObservationID   string `json:"startObservationId"`
	EndObservationID     string `json:"endObservationId"`
	StartSnapshotID      string `json:"startSnapshotId"`
	EndSnapshotID        string `json:"endSnapshotId"`
	HubName              string `json:"hubName"`
	CollectionDeviceID   string `json:"collectionDeviceId"`
	DeviceID             string `json:"deviceId"`
	RawServiceIdentifier string `json:"rawServiceIdentifier"`
	StartAt              string `json:"startAt"`
	EndAt                string `json:"endAt"`
	JSONPath             string `json:"jsonPath"`
	M08Route             string `json:"m08Route"`
}

type UsageNativeAmountSnapshot struct {
	ObservationID     string `json:"observationId"`
	HubName           string `json:"hubName"`
	DeviceID          string `json:"deviceId"`
	ServiceIdentifier string `json:"serviceIdentifier"`
	Label             string `json:"label"`
	Metric            string `json:"metric"`
	Used              string `json:"used"`
	Limit             string `json:"limit"`
	Remaining         string `json:"remaining"`
	Currency          string `json:"currency"`
	ObservedAt        string `json:"observedAt"`
	M08Route          string `json:"m08Route"`
}

type UsageSnapshot struct {
	GeneratedAt     string                      `json:"generatedAt"`
	From            string                      `json:"from"`
	To              string                      `json:"to"`
	DisplayTimeZone string                      `json:"displayTimeZone"`
	Granularity     string                      `json:"granularity"`
	GroupBy         string                      `json:"groupBy"`
	Summary         UsageSummarySnapshot        `json:"summary"`
	Series          []UsagePointSnapshot        `json:"series"`
	Breakdown       []UsageBreakdownSnapshot    `json:"breakdown"`
	NativeAmounts   []UsageNativeAmountSnapshot `json:"nativeAmounts"`
	Evidence        []UsageEvidenceSnapshot     `json:"evidence"`
}

type UsageExportSnapshot struct {
	Filename string `json:"filename"`
	MIMEType string `json:"mimeType"`
	Content  string `json:"content"`
}

type UsageExportRowSnapshot struct {
	PeriodStart      string  `json:"periodStart"`
	PeriodEnd        string  `json:"periodEnd"`
	Key              string  `json:"key"`
	CategoryKey      string  `json:"categoryKey"`
	Label            string  `json:"label"`
	Attribution      string  `json:"attribution"`
	Tokens           int64   `json:"tokens"`
	APICostUSD       float64 `json:"apiCostUsd"`
	APICostUSDText   string  `json:"apiCostUsdText"`
	ObservationCount int     `json:"observationCount"`
	EvidenceRoute    string  `json:"evidenceRoute"`
}

func NewUsageService(lifecycle *sqliteadapter.Lifecycle) (*UsageService, error) {
	if lifecycle == nil {
		return nil, errors.New("usage service lifecycle is required")
	}
	return NewUsageServiceWithDependencies(lifecycle, usecase.SystemClock{})
}

func NewUsageServiceWithDependencies(reader UsageReader, clock usecase.Clock) (*UsageService, error) {
	if reader == nil || clock == nil {
		return nil, errors.New("usage service dependencies are required")
	}
	return &UsageService{reader: reader, clock: clock}, nil
}

func (s *UsageService) GetUsage(ctx context.Context, input UsageFilterInput) (UsageSnapshot, error) {
	from, to, location, err := validateUsageFilter(input)
	if err != nil {
		return UsageSnapshot{}, err
	}
	observations, err := s.reader.ListUsageAnalysisObservations(ctx)
	if err != nil {
		return UsageSnapshot{}, err
	}
	deltas, err := domain.DeriveUsageDeltas(observations)
	if err != nil {
		return UsageSnapshot{}, err
	}
	filtered := make([]domain.UsageDelta, 0, len(deltas))
	for _, delta := range deltas {
		if delta.EndAt.Before(from) || !delta.EndAt.Before(to) || !matchesUsageFilter(delta, input) {
			continue
		}
		filtered = append(filtered, delta)
	}
	native, err := s.reader.ListUsageNativeAmounts(ctx)
	if err != nil {
		return UsageSnapshot{}, err
	}
	granularity := input.Granularity
	if granularity == "" {
		granularity = "day"
	}
	groupBy := input.GroupBy
	if groupBy == "" {
		groupBy = "hub"
	}
	result := UsageSnapshot{
		GeneratedAt: s.clock.Now().UTC().Format(time.RFC3339Nano), From: from.Format(time.RFC3339Nano), To: to.Format(time.RFC3339Nano),
		DisplayTimeZone: input.DisplayTimeZone, Granularity: granularity, GroupBy: groupBy,
		Series: []UsagePointSnapshot{}, Breakdown: []UsageBreakdownSnapshot{}, NativeAmounts: []UsageNativeAmountSnapshot{}, Evidence: []UsageEvidenceSnapshot{},
	}
	series := make(map[string]*UsagePointSnapshot)
	seriesBreakdown := make(map[string]map[string]*UsageBreakdownSnapshot)
	breakdown := make(map[string]*UsageBreakdownSnapshot)
	sources := make(map[string]struct{})
	for _, delta := range filtered {
		tokens, cost := usageDeltaValues(delta, input.Model)
		costText := cost
		sources[delta.SourceID] = struct{}{}
		result.Summary.Tokens += tokens
		result.Summary.APICostUSDText = addDecimal(result.Summary.APICostUSDText, costText)
		result.Summary.ObservationCount++
		if delta.Shared {
			result.Summary.SharedTokens += tokens
			result.Summary.SharedAPICostUSDText = addDecimal(result.Summary.SharedAPICostUSDText, costText)
		}
		periodStart, periodEnd := usagePeriod(delta.EndAt, granularity, location)
		periodKey := periodStart.Format(time.RFC3339Nano)
		point := series[periodKey]
		if point == nil {
			point = &UsagePointSnapshot{PeriodStart: periodKey, PeriodEnd: periodEnd.Format(time.RFC3339Nano), Breakdown: []UsageBreakdownSnapshot{}}
			series[periodKey] = point
			seriesBreakdown[periodKey] = make(map[string]*UsageBreakdownSnapshot)
		}
		point.Tokens += tokens
		point.APICostUSDText = addDecimal(point.APICostUSDText, costText)
		point.ObservationCount++
		if delta.Shared {
			point.SharedTokens += tokens
			point.SharedAPICostUSDText = addDecimal(point.SharedAPICostUSDText, costText)
		}
		attribution := "単一アカウントに帰属する利用実績"
		if delta.Shared {
			attribution = "共有利用実績"
		}
		for _, value := range usageBreakdownValues(delta, groupBy, input.Model) {
			addUsageBreakdown(breakdown, delta, value.Key, value.Label, attribution, value.Tokens, value.APICostUSDText)
			addUsageBreakdown(seriesBreakdown[periodKey], delta, value.Key, value.Label, attribution, value.Tokens, value.APICostUSDText)
		}
		result.Evidence = append(result.Evidence, usageEvidence(delta))
	}
	result.Summary.SourceCount = len(sources)
	result.Summary.APICostUSD = decimalFloat(result.Summary.APICostUSDText)
	result.Summary.SharedAPICostUSD = decimalFloat(result.Summary.SharedAPICostUSDText)
	keys := make([]string, 0, len(series))
	for key := range series {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		item := *series[key]
		item.APICostUSD, item.SharedAPICostUSD = decimalFloat(item.APICostUSDText), decimalFloat(item.SharedAPICostUSDText)
		for _, segment := range seriesBreakdown[key] {
			segment.APICostUSD = decimalFloat(segment.APICostUSDText)
			item.Breakdown = append(item.Breakdown, *segment)
		}
		sort.Slice(item.Breakdown, func(i, j int) bool { return item.Breakdown[i].Key < item.Breakdown[j].Key })
		result.Series = append(result.Series, item)
	}
	for _, item := range breakdown {
		item.APICostUSD = decimalFloat(item.APICostUSDText)
		result.Breakdown = append(result.Breakdown, *item)
	}
	result.Breakdown, result.Series = compactUsageCategories(result.Breakdown, result.Series, 5)
	for _, amount := range native {
		if amount.ObservedAt.Before(from) || !amount.ObservedAt.Before(to) || (input.HubID != "" && amount.HubID != input.HubID) || (input.DeviceID != "" && amount.DeviceID != input.DeviceID) {
			continue
		}
		result.NativeAmounts = append(result.NativeAmounts, UsageNativeAmountSnapshot{
			ObservationID: amount.ObservationID, HubName: amount.HubName, DeviceID: amount.DeviceID, ServiceIdentifier: amount.RawServiceIdentifier,
			Label: amount.Label, Metric: amount.Metric, Used: amount.UsedText, Limit: amount.LimitText, Remaining: amount.RemainingText, Currency: amount.Currency,
			ObservedAt: amount.ObservedAt.Format(time.RFC3339Nano), M08Route: "/evidence?snapshotId=" + amount.SnapshotID,
		})
	}
	return result, nil
}

func (s *UsageService) ExportUsage(ctx context.Context, input UsageFilterInput, format string) (UsageExportSnapshot, error) {
	result, err := s.GetUsage(ctx, input)
	if err != nil {
		return UsageExportSnapshot{}, err
	}
	stamp := s.clock.Now().UTC().Format("20060102T150405Z")
	rows := usageExportRows(result)
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "json":
		payload := struct {
			SchemaVersion string                   `json:"schemaVersion"`
			Metadata      map[string]string        `json:"metadata"`
			Rows          []UsageExportRowSnapshot `json:"rows"`
		}{usageExportSchemaVersion, usageMetadata(result, input), rows}
		body, marshalErr := json.MarshalIndent(payload, "", "  ")
		if marshalErr != nil {
			return UsageExportSnapshot{}, marshalErr
		}
		return UsageExportSnapshot{Filename: "usage-" + stamp + ".json", MIMEType: "application/json;charset=utf-8", Content: string(body)}, nil
	case "csv":
		var buffer bytes.Buffer
		buffer.WriteString("\ufeff")
		writer := csv.NewWriter(&buffer)
		header := []string{"schemaVersion", "generatedAtUtc", "from", "to", "displayTimeZone", "granularity", "groupBy", "observationType", "hubId", "collectionDeviceId", "deviceId", "serviceId", "rawServiceIdentifier", "logicalAccountId", "planVersionId", "limitDefinitionId", "model", "periodStart", "periodEnd", "key", "categoryKey", "label", "attribution", "tokens", "apiCostUsd", "observationCount"}
		_ = writer.Write(header)
		for _, row := range rows {
			_ = writer.Write([]string{usageExportSchemaVersion, result.GeneratedAt, result.From, result.To, result.DisplayTimeZone, result.Granularity, result.GroupBy, "observed", input.HubID, input.CollectionDeviceID, input.DeviceID, input.ServiceID, input.RawServiceIdentifier, input.LogicalAccountID, input.PlanVersionID, input.LimitDefinitionID, input.Model, row.PeriodStart, row.PeriodEnd, row.Key, row.CategoryKey, row.Label, row.Attribution, strconv.FormatInt(row.Tokens, 10), row.APICostUSDText, strconv.Itoa(row.ObservationCount)})
		}
		writer.Flush()
		if err := writer.Error(); err != nil {
			return UsageExportSnapshot{}, err
		}
		return UsageExportSnapshot{Filename: "usage-" + stamp + ".csv", MIMEType: "text/csv;charset=utf-8", Content: buffer.String()}, nil
	default:
		return UsageExportSnapshot{}, errors.New("export format must be csv or json")
	}
}

func validateUsageFilter(input UsageFilterInput) (time.Time, time.Time, *time.Location, error) {
	from, err := time.Parse(time.RFC3339Nano, input.From)
	if err != nil {
		return time.Time{}, time.Time{}, nil, errors.New("usage period start must be RFC3339")
	}
	to, err := time.Parse(time.RFC3339Nano, input.To)
	if err != nil || !from.Before(to) {
		return time.Time{}, time.Time{}, nil, errors.New("usage period end must be after the start")
	}
	location, err := timezoneadapter.LoadLocation(input.DisplayTimeZone)
	if err != nil {
		return time.Time{}, time.Time{}, nil, err
	}
	if input.Granularity != "" && input.Granularity != "hour" && input.Granularity != "day" && input.Granularity != "week" && input.Granularity != "month" {
		return time.Time{}, time.Time{}, nil, errors.New("unsupported usage granularity")
	}
	if input.GroupBy != "" && input.GroupBy != "all" && input.GroupBy != "hub" && input.GroupBy != "collectionDevice" && input.GroupBy != "device" && input.GroupBy != "service" && input.GroupBy != "rawService" && input.GroupBy != "agent" && input.GroupBy != "account" && input.GroupBy != "contract" && input.GroupBy != "model" {
		return time.Time{}, time.Time{}, nil, errors.New("unsupported usage classification")
	}
	return from.UTC(), to.UTC(), location, nil
}

func matchesUsageFilter(delta domain.UsageDelta, input UsageFilterInput) bool {
	if input.HubID != "" && delta.HubID != input.HubID || input.CollectionDeviceID != "" && delta.CollectionDeviceID != input.CollectionDeviceID || input.DeviceID != "" && delta.DeviceID != input.DeviceID || input.ServiceID != "" && delta.ServiceID != input.ServiceID || input.RawServiceIdentifier != "" && delta.RawServiceIdentifier != input.RawServiceIdentifier {
		return false
	}
	if input.LogicalAccountID != "" {
		found := false
		for _, id := range delta.AccountIDs {
			if id == input.LogicalAccountID {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if input.PlanVersionID != "" && !containsString(delta.PlanVersionIDs, input.PlanVersionID) {
		return false
	}
	if input.LimitDefinitionID != "" && !containsString(delta.LimitDefinitionIDs, input.LimitDefinitionID) {
		return false
	}
	if input.Model != "" {
		_, tokens := delta.ModelTokens[input.Model]
		_, costs := delta.ModelCosts[input.Model]
		return tokens || costs
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func usageDeltaValues(delta domain.UsageDelta, model string) (int64, string) {
	if model == "" {
		return delta.Tokens, delta.APICostUSDText
	}
	return delta.ModelTokens[model], delta.ModelCosts[model]
}

func usagePeriod(at time.Time, granularity string, location *time.Location) (time.Time, time.Time) {
	local := at.In(location)
	switch granularity {
	case "hour":
		start := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), 0, 0, 0, location)
		return start, start.Add(time.Hour)
	case "week":
		start, _ := domain.MondayWeekStart(local, location)
		return start, start.AddDate(0, 0, 7)
	case "month":
		start := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, location)
		return start, start.AddDate(0, 1, 0)
	default:
		start, end, _ := domain.LocalDayBounds(local, location)
		return start.In(location), end.In(location)
	}
}

func usageGroup(delta domain.UsageDelta, groupBy, selectedModel string) (string, string) {
	switch groupBy {
	case "all":
		return "all", "全体"
	case "collectionDevice":
		if delta.CollectionDeviceID == "" {
			return "unassigned-collection-device", "収集端末未同定"
		}
		return delta.CollectionDeviceID, delta.CollectionDeviceID
	case "device":
		return delta.DeviceID, delta.DeviceID
	case "service":
		if delta.ServiceID == "" {
			return "unmapped:" + delta.RawServiceIdentifier, "未同定（" + delta.RawServiceIdentifier + "）"
		}
		return delta.ServiceID, delta.ServiceName
	case "rawService", "agent":
		if strings.TrimSpace(delta.RawServiceIdentifier) == "" {
			return "unidentified-agent", "未同定"
		}
		return delta.RawServiceIdentifier, delta.RawServiceIdentifier
	case "contract":
		if len(delta.PlanVersionIDs) == 0 {
			return "unidentified-contract", "契約未同定"
		}
		names := make([]string, len(delta.PlanVersionIDs))
		for index, id := range delta.PlanVersionIDs {
			names[index] = id
			if index < len(delta.PlanVersionNames) && strings.TrimSpace(delta.PlanVersionNames[index]) != "" {
				names[index] = delta.PlanVersionNames[index]
			}
		}
		if len(delta.PlanVersionIDs) == 1 {
			return delta.PlanVersionIDs[0], names[0]
		}
		return "multiple-contracts:" + strings.Join(delta.PlanVersionIDs, "\x1f"), "複数契約（" + strings.Join(names, " / ") + "）"
	case "account":
		if delta.Shared {
			return "shared", "共有利用実績"
		}
		if len(delta.AccountIDs) == 1 {
			return delta.AccountIDs[0], delta.AccountNames[0]
		}
		return "unassigned", "未帰属"
	case "model":
		if selectedModel != "" {
			return selectedModel, selectedModel
		}
		return "all-models", "全モデル"
	default:
		return delta.HubID, delta.HubName
	}
}

type usageBreakdownValue struct {
	Key, Label, APICostUSDText string
	Tokens                     int64
}

func usageBreakdownValues(delta domain.UsageDelta, groupBy, selectedModel string) []usageBreakdownValue {
	if groupBy != "model" || selectedModel != "" {
		key, label := usageGroup(delta, groupBy, selectedModel)
		tokens, cost := usageDeltaValues(delta, selectedModel)
		return []usageBreakdownValue{{Key: key, Label: label, Tokens: tokens, APICostUSDText: cost}}
	}
	models := make(map[string]struct{})
	for model := range delta.ModelTokens {
		models[model] = struct{}{}
	}
	for model := range delta.ModelCosts {
		models[model] = struct{}{}
	}
	modelKeys := make([]string, 0, len(models))
	for model := range models {
		modelKeys = append(modelKeys, model)
	}
	sort.Strings(modelKeys)
	result := make([]usageBreakdownValue, 0, len(modelKeys))
	for _, model := range modelKeys {
		result = append(result, usageBreakdownValue{Key: model, Label: model, Tokens: delta.ModelTokens[model], APICostUSDText: delta.ModelCosts[model]})
	}
	return result
}

func addUsageBreakdown(breakdown map[string]*UsageBreakdownSnapshot, delta domain.UsageDelta, key, label, attribution string, tokens int64, costText string) {
	categoryKey := key
	if delta.Shared {
		key += ":shared"
	}
	row := breakdown[key]
	if row == nil {
		row = &UsageBreakdownSnapshot{Key: key, CategoryKey: categoryKey, Label: label, Attribution: attribution, EvidenceRoute: "/evidence?usageObservationId=" + delta.EndObservationID}
		breakdown[key] = row
	}
	row.Tokens += tokens
	row.APICostUSDText = addDecimal(row.APICostUSDText, costText)
	row.ObservationCount++
}

type usageCategoryRank struct {
	key, label    string
	tokens        int64
	cost          float64
	tokenShare    float64
	costShare     float64
	combinedShare float64
}

// compactUsageCategories selects one category set for both metrics. Categories
// important on either axis remain visible; every lower category is aggregated
// into the same neutral "other" category while attribution remains explicit.
func compactUsageCategories(breakdown []UsageBreakdownSnapshot, series []UsagePointSnapshot, limit int) ([]UsageBreakdownSnapshot, []UsagePointSnapshot) {
	byCategory := make(map[string]*usageCategoryRank)
	var totalTokens int64
	var totalCost float64
	for _, row := range breakdown {
		category := byCategory[row.CategoryKey]
		if category == nil {
			category = &usageCategoryRank{key: row.CategoryKey, label: row.Label}
			byCategory[row.CategoryKey] = category
		}
		category.tokens += row.Tokens
		category.cost += row.APICostUSD
		totalTokens += row.Tokens
		totalCost += row.APICostUSD
	}
	ranking := make([]usageCategoryRank, 0, len(byCategory))
	for _, category := range byCategory {
		if totalTokens > 0 {
			category.tokenShare = float64(category.tokens) / float64(totalTokens)
		}
		if totalCost > 0 {
			category.costShare = category.cost / totalCost
		}
		category.combinedShare = (category.tokenShare + category.costShare) / 2
		ranking = append(ranking, *category)
	}
	sort.Slice(ranking, func(i, j int) bool {
		if ranking[i].combinedShare != ranking[j].combinedShare {
			return ranking[i].combinedShare > ranking[j].combinedShare
		}
		if ranking[i].tokenShare != ranking[j].tokenShare {
			return ranking[i].tokenShare > ranking[j].tokenShare
		}
		if ranking[i].costShare != ranking[j].costShare {
			return ranking[i].costShare > ranking[j].costShare
		}
		return ranking[i].key < ranking[j].key
	})
	visible := make(map[string]int, limit)
	for index, category := range ranking {
		if index >= limit {
			break
		}
		visible[category.key] = index
	}
	compact := func(rows []UsageBreakdownSnapshot) []UsageBreakdownSnapshot {
		result := make([]UsageBreakdownSnapshot, 0, len(rows))
		other := make(map[string]*UsageBreakdownSnapshot, 2)
		for _, row := range rows {
			if _, ok := visible[row.CategoryKey]; ok || len(ranking) <= limit {
				result = append(result, row)
				continue
			}
			key := "other"
			if row.Attribution == "共有利用実績" {
				key += ":shared"
			}
			aggregate := other[key]
			if aggregate == nil {
				aggregate = &UsageBreakdownSnapshot{Key: key, CategoryKey: "other", Label: "それ以外", Attribution: row.Attribution, EvidenceRoute: row.EvidenceRoute}
				other[key] = aggregate
			}
			aggregate.Tokens += row.Tokens
			aggregate.APICostUSDText = addDecimal(aggregate.APICostUSDText, row.APICostUSDText)
			aggregate.ObservationCount += row.ObservationCount
		}
		for _, row := range other {
			row.APICostUSD = decimalFloat(row.APICostUSDText)
			result = append(result, *row)
		}
		sort.Slice(result, func(i, j int) bool {
			left, leftVisible := visible[result[i].CategoryKey]
			right, rightVisible := visible[result[j].CategoryKey]
			if leftVisible != rightVisible {
				return leftVisible
			}
			if leftVisible && left != right {
				return left < right
			}
			if result[i].CategoryKey != result[j].CategoryKey {
				return result[i].CategoryKey < result[j].CategoryKey
			}
			return result[i].Key < result[j].Key
		})
		return result
	}
	breakdown = compact(breakdown)
	for index := range series {
		series[index].Breakdown = compact(series[index].Breakdown)
	}
	return breakdown, series
}

func usageEvidence(delta domain.UsageDelta) UsageEvidenceSnapshot {
	return UsageEvidenceSnapshot{
		SourceID: delta.SourceID, StartObservationID: delta.StartObservationID, EndObservationID: delta.EndObservationID,
		StartSnapshotID: delta.StartSnapshotID, EndSnapshotID: delta.EndSnapshotID, HubName: delta.HubName, DeviceID: delta.DeviceID,
		CollectionDeviceID:   delta.CollectionDeviceID,
		RawServiceIdentifier: delta.RawServiceIdentifier, StartAt: delta.StartAt.Format(time.RFC3339Nano), EndAt: delta.EndAt.Format(time.RFC3339Nano),
		JSONPath: delta.JSONPath, M08Route: "/evidence?usageObservationId=" + delta.EndObservationID,
	}
}

func addDecimal(left, right string) string {
	if left == "" {
		left = "0"
	}
	if right == "" {
		right = "0"
	}
	a, aOK := new(big.Rat).SetString(left)
	b, bOK := new(big.Rat).SetString(right)
	if !aOK || !bOK {
		return "0"
	}
	value := new(big.Rat).Add(a, b)
	for precision := 0; precision <= 18; precision++ {
		text := value.FloatString(precision)
		if parsed, ok := new(big.Rat).SetString(text); ok && parsed.Cmp(value) == 0 {
			if strings.Contains(text, ".") {
				text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
			}
			return text
		}
	}
	return value.FloatString(18)
}

func decimalFloat(value string) float64 {
	if value == "" {
		return 0
	}
	result, _ := strconv.ParseFloat(value, 64)
	return result
}

func usageExportRows(result UsageSnapshot) []UsageExportRowSnapshot {
	rows := make([]UsageExportRowSnapshot, 0)
	for _, point := range result.Series {
		for _, segment := range point.Breakdown {
			rows = append(rows, UsageExportRowSnapshot{
				PeriodStart: point.PeriodStart, PeriodEnd: point.PeriodEnd,
				Key: segment.Key, CategoryKey: segment.CategoryKey, Label: segment.Label, Attribution: segment.Attribution,
				Tokens: segment.Tokens, APICostUSD: segment.APICostUSD, APICostUSDText: segment.APICostUSDText,
				ObservationCount: segment.ObservationCount, EvidenceRoute: segment.EvidenceRoute,
			})
		}
	}
	return rows
}

func usageMetadata(result UsageSnapshot, input UsageFilterInput) map[string]string {
	return map[string]string{
		"generatedAtUtc": result.GeneratedAt, "from": result.From, "to": result.To,
		"displayTimeZone": result.DisplayTimeZone, "granularity": result.Granularity,
		"groupBy": result.GroupBy, "observationType": "observed", "units": "tokens, apiCostUsd",
		"hubId": input.HubID, "collectionDeviceId": input.CollectionDeviceID, "deviceId": input.DeviceID,
		"serviceId": input.ServiceID, "rawServiceIdentifier": input.RawServiceIdentifier,
		"logicalAccountId": input.LogicalAccountID, "planVersionId": input.PlanVersionID,
		"limitDefinitionId": input.LimitDefinitionID, "model": input.Model,
	}
}
