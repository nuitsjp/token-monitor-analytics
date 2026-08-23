package analytics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const maxStatsResponseSize = 10 << 20

type Stats struct {
	UpdatedAt string                   `json:"updatedAt"`
	Periods   map[string]PeriodSummary `json:"periods"`
	Limits    Limits                   `json:"limits"`
	Devices   []Device                 `json:"devices"`
}

type PeriodSummary struct {
	TotalTokens float64            `json:"totalTokens"`
	CostUSD     float64            `json:"costUsd"`
	Clients     map[string]float64 `json:"clients"`
	ClientCosts map[string]float64 `json:"clientCosts"`
	Models      map[string]float64 `json:"models"`
	ModelCosts  map[string]float64 `json:"modelCosts"`
}

type Device struct {
	DeviceID string                   `json:"deviceId"`
	Hostname string                   `json:"hostname"`
	Periods  map[string]PeriodSummary `json:"periods"`
}

type Limits struct {
	Providers []Provider `json:"providers"`
}

type Provider struct {
	Provider     string   `json:"provider"`
	AccountKey   string   `json:"accountKey"`
	AccountName  string   `json:"accountName"`
	AccountEmail string   `json:"accountEmail"`
	PlanLabel    string   `json:"planLabel"`
	Windows      []Window `json:"windows"`
}

type Window struct {
	Kind             string   `json:"kind"`
	Metric           string   `json:"metric"`
	Label            string   `json:"label"`
	UsedPercent      *float64 `json:"usedPercent"`
	RemainingPercent *float64 `json:"remainingPercent"`
	ResetsAt         string   `json:"resetsAt"`
	Used             *float64 `json:"used"`
	Limit            *float64 `json:"limit"`
	Remaining        *float64 `json:"remaining"`
	Currency         string   `json:"currency"`
	ShowMeter        *bool    `json:"showMeter"`
}

type Observation struct {
	Provider           string  `json:"provider"`
	AccountKey         string  `json:"accountKey"`
	AccountLabel       string  `json:"accountLabel"`
	WindowKind         string  `json:"windowKind"`
	WindowLabel        string  `json:"windowLabel"`
	PeriodKey          string  `json:"periodKey"`
	PeriodStart        string  `json:"periodStart"`
	PeriodEnd          string  `json:"periodEnd"`
	ResetAt            string  `json:"resetAt"`
	UsageUSD           float64 `json:"usageUsd"`
	UtilizationPercent float64 `json:"utilizationPercent"`
	EstimatedLimitUSD  float64 `json:"estimatedLimitUsd"`
	CalculationStatus  string  `json:"calculationStatus"`
	CalculationNote    string  `json:"calculationNote"`
	ObservedAt         string  `json:"observedAt"`
	CalculatedAt       string  `json:"calculatedAt"`
}

type ParseResult struct {
	Stats        Stats
	Observations []Observation
}

type UsageBreakdown struct {
	Dimension string  `json:"dimension"`
	Key       string  `json:"key"`
	Label     string  `json:"label"`
	Tokens    float64 `json:"tokens"`
	CostUSD   float64 `json:"costUsd"`
}

type StatsAnalysis struct {
	PeriodKey             string             `json:"periodKey"`
	TotalTokens           float64            `json:"totalTokens"`
	TotalCostUSD          float64            `json:"totalCostUsd"`
	ProviderCosts         map[string]float64 `json:"providerCosts"`
	ProviderAccountCounts map[string]int     `json:"providerAccountCounts"`
	Breakdowns            []UsageBreakdown   `json:"breakdowns"`
}

func ParseAndCalculate(raw []byte, observedAt time.Time) (ParseResult, error) {
	var stats Stats
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&stats); err != nil {
		return ParseResult{}, fmt.Errorf("decode stats: %w", err)
	}
	if stats.Periods == nil {
		stats.Periods = map[string]PeriodSummary{}
	}
	calculatedAt := time.Now().UTC().Format(time.RFC3339Nano)
	observed := observedAt.UTC().Format(time.RFC3339Nano)
	result := ParseResult{Stats: stats}
	providerRowCount := make(map[string]int)
	for _, provider := range stats.Limits.Providers {
		providerName := strings.TrimSpace(provider.Provider)
		if providerName != "" {
			providerRowCount[providerName]++
		}
	}
	for _, provider := range stats.Limits.Providers {
		providerName := strings.TrimSpace(provider.Provider)
		if providerName == "" {
			continue
		}
		for _, window := range provider.Windows {
			observation := Observation{
				Provider:          providerName,
				AccountKey:        provider.AccountKey,
				AccountLabel:      firstNonEmpty(provider.AccountName, provider.AccountEmail, provider.PlanLabel, provider.AccountKey),
				WindowKind:        window.Kind,
				WindowLabel:       firstNonEmpty(window.Label, window.Kind),
				ResetAt:           window.ResetsAt,
				CalculationStatus: "unsupported_window",
				ObservedAt:        observed,
				CalculatedAt:      calculatedAt,
			}
			if providerRowCount[providerName] > 1 {
				observation.CalculationStatus = "ambiguous_account_cost"
				observation.CalculationNote = "provider has multiple account rows; provider total cost cannot be assigned to one account"
				result.Observations = append(result.Observations, observation)
				continue
			}
			periodKey, period, exact := matchingPeriod(stats.Periods, window.Kind)
			if period == nil {
				observation.CalculationStatus = "missing_period"
				observation.CalculationNote = "API response does not contain a cost period matching this quota window"
				result.Observations = append(result.Observations, observation)
				continue
			}
			observation.PeriodKey = periodKey
			observation.PeriodStart, observation.PeriodEnd = periodBounds(window.Kind, periodKey, observedAt, window.ResetsAt)
			var usageAvailable bool
			observation.UsageUSD, observation.CalculationNote, usageAvailable = usageForProvider(*period, providerName)
			if observation.CalculationNote == "" {
				observation.CalculationNote = "provider clientCosts"
			}
			if !usageAvailable {
				observation.CalculationStatus = "missing_provider_cost"
				result.Observations = append(result.Observations, observation)
				continue
			}
			observation.UtilizationPercent = utilizationPercent(window)
			if observation.UtilizationPercent <= 0 || observation.UtilizationPercent > 100 {
				observation.CalculationStatus = "invalid_utilization"
				observation.CalculationNote = "usedPercent must be greater than 0 and at most 100"
			} else if !exact {
				observation.CalculationStatus = "partial_period"
				observation.CalculationNote += "; today cost is retained as a reference only; estimate is intentionally omitted"
			} else {
				observation.CalculationStatus = "ok"
				observation.EstimatedLimitUSD = observation.UsageUSD / (observation.UtilizationPercent / 100)
			}
			result.Observations = append(result.Observations, observation)
		}
	}
	return result, nil
}

func AnalyzeStats(raw []byte, periodKey string) (StatsAnalysis, error) {
	var stats Stats
	if err := json.Unmarshal(raw, &stats); err != nil {
		return StatsAnalysis{}, fmt.Errorf("decode stats for analysis: %w", err)
	}
	period, ok := stats.Periods[periodKey]
	if !ok {
		return StatsAnalysis{}, fmt.Errorf("stats period %q is missing", periodKey)
	}
	analysis := StatsAnalysis{
		PeriodKey:             periodKey,
		TotalTokens:           period.TotalTokens,
		TotalCostUSD:          period.CostUSD,
		ProviderCosts:         make(map[string]float64),
		ProviderAccountCounts: make(map[string]int),
	}
	for provider, cost := range period.ClientCosts {
		analysis.ProviderCosts[strings.ToLower(strings.TrimSpace(provider))] = cost
	}
	accountKeys := make(map[string]map[string]struct{})
	for index, provider := range stats.Limits.Providers {
		providerName := strings.ToLower(strings.TrimSpace(provider.Provider))
		if providerName == "" {
			continue
		}
		if accountKeys[providerName] == nil {
			accountKeys[providerName] = make(map[string]struct{})
		}
		accountKey := strings.TrimSpace(provider.AccountKey)
		if accountKey == "" {
			accountKey = fmt.Sprintf("row:%d", index)
		}
		accountKeys[providerName][accountKey] = struct{}{}
	}
	for provider, keys := range accountKeys {
		analysis.ProviderAccountCounts[provider] = len(keys)
	}
	analysis.Breakdowns = append(analysis.Breakdowns, breakdownRows("tool", period.Clients, period.ClientCosts)...)
	analysis.Breakdowns = append(analysis.Breakdowns, breakdownRows("model", period.Models, period.ModelCosts)...)
	for _, device := range stats.Devices {
		devicePeriod, ok := device.Periods[periodKey]
		if !ok {
			continue
		}
		label := firstNonEmpty(device.Hostname, device.DeviceID)
		analysis.Breakdowns = append(analysis.Breakdowns, UsageBreakdown{
			Dimension: "device",
			Key:       firstNonEmpty(device.DeviceID, device.Hostname),
			Label:     label,
			Tokens:    devicePeriod.TotalTokens,
			CostUSD:   devicePeriod.CostUSD,
		})
	}
	return analysis, nil
}

func breakdownRows(dimension string, tokens, costs map[string]float64) []UsageBreakdown {
	keys := make(map[string]struct{}, len(tokens)+len(costs))
	for key := range tokens {
		keys[key] = struct{}{}
	}
	for key := range costs {
		keys[key] = struct{}{}
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Slice(ordered, func(left, right int) bool {
		leftCost, rightCost := costs[ordered[left]], costs[ordered[right]]
		if leftCost == rightCost {
			return ordered[left] < ordered[right]
		}
		return leftCost > rightCost
	})
	rows := make([]UsageBreakdown, 0, len(ordered))
	for _, key := range ordered {
		rows = append(rows, UsageBreakdown{
			Dimension: dimension,
			Key:       key,
			Label:     key,
			Tokens:    tokens[key],
			CostUSD:   costs[key],
		})
	}
	return rows
}

func FetchStats(ctx context.Context, client *http.Client, hubURL, secret string) ([]byte, time.Time, error) {
	hubURL = strings.TrimRight(strings.TrimSpace(hubURL), "/")
	parsed, err := url.Parse(hubURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, time.Time{}, errors.New("hub URL must be an http or https URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, hubURL+"/api/stats", nil)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("create stats request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("request stats: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, time.Time{}, fmt.Errorf("stats request returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxStatsResponseSize+1))
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("read stats response: %w", err)
	}
	if len(body) > maxStatsResponseSize {
		return nil, time.Time{}, fmt.Errorf("stats response exceeds %d bytes", maxStatsResponseSize)
	}
	return body, time.Now().UTC(), nil
}

func matchingPeriod(periods map[string]PeriodSummary, kind string) (string, *PeriodSummary, bool) {
	for _, key := range exactPeriodKeys(kind) {
		if period, ok := periods[key]; ok {
			return key, &period, true
		}
	}
	// The current Hub API exposes today/month/allTime. today is retained as a
	// clearly marked partial observation for session/weekly windows; month is
	// never used for those windows because the periods would differ.
	if kind == "session" || kind == "weekly" {
		if period, ok := periods["today"]; ok {
			return "today", &period, false
		}
	}
	return "", nil, false
}

func exactPeriodKeys(kind string) []string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "session":
		return []string{"session", "5h", "fiveHour"}
	case "weekly":
		return []string{"weekly", "week", "7d"}
	case "billing":
		return []string{"billing", "cycle", "month"}
	default:
		return nil
	}
}

func usageForProvider(period PeriodSummary, provider string) (float64, string, bool) {
	if len(period.ClientCosts) > 0 {
		if cost, ok := period.ClientCosts[provider]; ok {
			return cost, "provider clientCosts", true
		}
		for key, cost := range period.ClientCosts {
			if strings.EqualFold(key, provider) {
				return cost, "provider clientCosts (case-insensitive match)", true
			}
		}
		return 0, "provider clientCosts has no matching provider", false
	}
	return 0, "period has no provider-level clientCosts", false
}

func utilizationPercent(window Window) float64 {
	if window.UsedPercent != nil {
		return percentValue(*window.UsedPercent)
	}
	if window.RemainingPercent != nil {
		return 100 - percentValue(*window.RemainingPercent)
	}
	return 0
}

func percentValue(value float64) float64 {
	if value >= 0 && value <= 1 {
		return value * 100
	}
	return value
}

func periodBounds(kind, periodKey string, observedAt time.Time, resetAt string) (string, string) {
	end := observedAt.UTC()
	if parsed, err := time.Parse(time.RFC3339, resetAt); err == nil {
		end = parsed.UTC()
	}
	start := time.Time{}
	switch strings.ToLower(kind) {
	case "session":
		start = end.Add(-5 * time.Hour)
	case "weekly":
		start = end.Add(-7 * 24 * time.Hour)
	case "billing":
		if periodKey == "month" {
			start = time.Date(observedAt.UTC().Year(), observedAt.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
		}
	}
	if periodKey == "today" {
		start = time.Date(observedAt.UTC().Year(), observedAt.UTC().Month(), observedAt.UTC().Day(), 0, 0, 0, 0, time.UTC)
	}
	if start.IsZero() {
		return "", resetAt
	}
	return start.Format(time.RFC3339Nano), resetAt
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return "(unknown)"
}
