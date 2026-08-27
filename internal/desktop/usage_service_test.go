package desktop

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

type usageTestReader struct {
	observations []domain.UsageObservation
	amounts      []sqliteadapter.UsageNativeAmount
}

func (r usageTestReader) ListUsageAnalysisObservations(context.Context) ([]domain.UsageObservation, error) {
	return r.observations, nil
}
func (r usageTestReader) ListUsageNativeAmounts(context.Context) ([]sqliteadapter.UsageNativeAmount, error) {
	return r.amounts, nil
}

type usageTestClock struct{ now time.Time }

func (c usageTestClock) Now() time.Time { return c.now }

func TestUsageServiceAggregatesOnceAndExportsScreenRows(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 3, 8, 5, 0, 0, 0, time.UTC)
	reader := usageTestReader{observations: []domain.UsageObservation{
		{ID: "one", SnapshotID: "snap-one", SourceID: "source", HubID: "hub", HubName: "Home Hub", DeviceID: "device", RawServiceIdentifier: "codex", ServiceID: "service", ServiceName: "Codex", ObservedAt: start, TokenCount: 100, APICostUSDText: "1.1", ModelTokens: map[string]int64{"gpt-5": 100}, ModelCosts: map[string]string{"gpt-5": "1.1"}, AccountIDs: []string{"a", "b"}, AccountNames: []string{"A", "B"}, CompletenessConfirmed: true},
		{ID: "two", SnapshotID: "snap-two", SourceID: "source", HubID: "hub", HubName: "Home Hub", DeviceID: "device", RawServiceIdentifier: "codex", ServiceID: "service", ServiceName: "Codex", ObservedAt: start.Add(4 * time.Hour), TokenCount: 250, APICostUSDText: "3.35", ModelTokens: map[string]int64{"gpt-5": 250}, ModelCosts: map[string]string{"gpt-5": "3.35"}, AccountIDs: []string{"a", "b"}, AccountNames: []string{"A", "B"}, CompletenessConfirmed: true},
	}, amounts: []sqliteadapter.UsageNativeAmount{{ObservationID: "amount", SnapshotID: "snap-two", HubID: "hub", HubName: "Home Hub", DeviceID: "device", RawServiceIdentifier: "credits", Label: "Credits", Metric: "credits", ObservedAt: start.Add(4 * time.Hour), RemainingText: "42", Currency: "CREDITS"}}}
	service, err := NewUsageServiceWithDependencies(reader, usageTestClock{now: start.Add(5 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	input := UsageFilterInput{From: start.Add(-time.Hour).Format(time.RFC3339), To: start.Add(24 * time.Hour).Format(time.RFC3339), DisplayTimeZone: "America/New_York", Granularity: "week", GroupBy: "service", HubID: "hub"}
	result, err := service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("usage series exposes observed tokens and API cost", func(t *testing.T) {
		if result.Summary.Tokens != 150 || result.Summary.APICostUSDText != "2.25" || len(result.Series) != 1 || result.Series[0].Tokens != 150 || result.Series[0].APICostUSDText != "2.25" || len(result.Series[0].Breakdown) != 1 || result.Series[0].Breakdown[0].Key != "service:shared" || result.Series[0].Breakdown[0].Tokens != 150 || result.Series[0].Breakdown[0].APICostUSDText != "2.25" {
			t.Fatalf("usage series = %#v", result)
		}
	})
	t.Run("P2-VIS-03 usage rows retain source and M08 evidence routes", func(t *testing.T) {
		if len(result.Evidence) != 1 || result.Evidence[0].StartObservationID != "one" || result.Evidence[0].EndObservationID != "two" || result.Evidence[0].M08Route == "" || len(result.Breakdown) != 1 || result.Breakdown[0].EvidenceRoute == "" {
			t.Fatalf("usage evidence = %#v", result)
		}
	})
	accountInput := input
	accountInput.GroupBy = "account"
	accountResult, err := service.GetUsage(context.Background(), accountInput)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P2-USAGE-03 account grouping distinguishes shared activity", func(t *testing.T) {
		if len(accountResult.Breakdown) != 1 || accountResult.Breakdown[0].Key != "shared:shared" || accountResult.Breakdown[0].Attribution != "共有利用実績" || accountResult.Breakdown[0].Tokens != 150 {
			t.Fatalf("account grouping = %#v", accountResult.Breakdown)
		}
	})
	t.Run("P2-USAGE-04 shared activity is not presented as an estimated account contribution", func(t *testing.T) {
		if len(accountResult.Breakdown) != 1 || strings.Contains(accountResult.Breakdown[0].Attribution, "推定") || accountResult.Breakdown[0].Attribution != "共有利用実績" {
			t.Fatalf("shared attribution = %#v", accountResult.Breakdown)
		}
	})
	t.Run("P2-USAGE-05 observed usage is included independently of limit eligibility", func(t *testing.T) {
		if result.Summary.Tokens != 150 || result.Summary.SharedTokens != 150 || result.Summary.APICostUSDText != "2.25" {
			t.Fatalf("observed usage summary = %#v", result.Summary)
		}
	})
	t.Run("P2-USAGE-08 display timezone and calendar period are preserved", func(t *testing.T) {
		if result.DisplayTimeZone != "America/New_York" || result.From == "" || result.To == "" || len(result.Series) != 1 {
			t.Fatalf("usage period metadata = %#v", result)
		}
		periodStart, startErr := time.Parse(time.RFC3339Nano, result.Series[0].PeriodStart)
		periodEnd, endErr := time.Parse(time.RFC3339Nano, result.Series[0].PeriodEnd)
		_, startOffset := periodStart.Zone()
		_, endOffset := periodEnd.Zone()
		if startErr != nil || endErr != nil || periodStart.Weekday() != time.Monday || startOffset != -5*60*60 || endOffset != -4*60*60 {
			t.Fatalf("calendar period = %s..%s (%v/%v)", result.Series[0].PeriodStart, result.Series[0].PeriodEnd, startErr, endErr)
		}
	})
	t.Run("P2-VIS-04 CSV export contains the active filter metadata and row values", func(t *testing.T) {
		csvResult, exportErr := service.ExportUsage(context.Background(), input, "csv")
		if exportErr != nil {
			t.Fatal(exportErr)
		}
		if !strings.HasPrefix(csvResult.Content, "\ufeff") {
			t.Fatalf("CSV has no UTF-8 BOM: %q", csvResult.Content)
		}
		rows, readErr := csv.NewReader(strings.NewReader(strings.TrimPrefix(csvResult.Content, "\ufeff"))).ReadAll()
		if readErr != nil || len(rows) != 2 {
			t.Fatalf("CSV rows = %#v err=%v", rows, readErr)
		}
		columns := make(map[string]int, len(rows[0]))
		for index, column := range rows[0] {
			columns[column] = index
		}
		for _, required := range []string{"schemaVersion", "displayTimeZone", "observationType", "hubId", "periodStart", "periodEnd", "categoryKey", "tokens", "apiCostUsd"} {
			if _, ok := columns[required]; !ok {
				t.Fatalf("CSV column %q missing: %v", required, rows[0])
			}
		}
		if rows[1][columns["schemaVersion"]] != "2" || rows[1][columns["displayTimeZone"]] != "America/New_York" || rows[1][columns["observationType"]] != "observed" || rows[1][columns["hubId"]] != "hub" || rows[1][columns["periodStart"]] == "" || rows[1][columns["periodEnd"]] == "" || rows[1][columns["categoryKey"]] != "service" || rows[1][columns["tokens"]] != "150" || rows[1][columns["apiCostUsd"]] != "2.25" {
			t.Fatalf("CSV row = %v", rows[1])
		}
	})
	t.Run("P2-VIS-05 JSON export has the required schema and rows", func(t *testing.T) {
		jsonResult, exportErr := service.ExportUsage(context.Background(), input, "json")
		if exportErr != nil {
			t.Fatal(exportErr)
		}
		var payload struct {
			SchemaVersion string                   `json:"schemaVersion"`
			Metadata      map[string]string        `json:"metadata"`
			Rows          []UsageExportRowSnapshot `json:"rows"`
		}
		if err := json.Unmarshal([]byte(jsonResult.Content), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.SchemaVersion != "2" || payload.Metadata["displayTimeZone"] != "America/New_York" || payload.Metadata["hubId"] != "hub" || len(payload.Rows) != 1 || payload.Rows[0].PeriodStart == "" || payload.Rows[0].PeriodEnd == "" || payload.Rows[0].APICostUSDText != "2.25" || payload.Rows[0].Tokens != 150 {
			t.Fatalf("JSON export = %#v", payload)
		}
	})
	t.Run("AC-P2-05 period summary counts each source delta once", func(t *testing.T) {
		if result.Summary.SourceCount != 1 || result.Summary.ObservationCount != 1 || result.Summary.Tokens != 150 || result.Summary.APICostUSDText != "2.25" {
			t.Fatalf("deduplicated summary = %#v", result.Summary)
		}
	})
	t.Run("AC-P2-06 shared totals remain separate from account attribution", func(t *testing.T) {
		if result.Summary.SharedTokens != 150 || result.Summary.SharedAPICostUSDText != "2.25" || accountResult.Breakdown[0].Attribution != "共有利用実績" {
			t.Fatalf("shared summary = %#v account=%#v", result.Summary, accountResult.Breakdown)
		}
	})
	t.Run("AC-P2-07 weekly series uses Monday and the selected IANA timezone", func(t *testing.T) {
		if result.DisplayTimeZone != "America/New_York" || len(result.Series) != 1 {
			t.Fatalf("timezone result = %#v", result)
		}
		period, parseErr := time.Parse(time.RFC3339Nano, result.Series[0].PeriodStart)
		if parseErr != nil || period.Weekday() != time.Monday {
			t.Fatalf("week does not start Monday: %s err=%v", result.Series[0].PeriodStart, parseErr)
		}
	})
	t.Run("AC-P2-08 CSV and JSON exports reflect the same filtered observation", func(t *testing.T) {
		csvResult, csvErr := service.ExportUsage(context.Background(), input, "csv")
		jsonResult, jsonErr := service.ExportUsage(context.Background(), input, "json")
		if csvErr != nil || jsonErr != nil || !strings.Contains(csvResult.Content, ",150,2.25,") || !strings.Contains(jsonResult.Content, `"apiCostUsdText": "2.25"`) {
			t.Fatalf("export mismatch: csv=%v json=%v", csvErr, jsonErr)
		}
	})
}

func TestUsageServiceBreaksDownEveryObservedModel(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	reader := usageTestReader{observations: []domain.UsageObservation{
		{ID: "one", SourceID: "source", HubID: "hub", ObservedAt: start, TokenCount: 100, APICostUSDText: "1", ModelTokens: map[string]int64{"gpt-5": 60, "claude": 40}, ModelCosts: map[string]string{"gpt-5": "0.6", "claude": "0.4"}, AccountIDs: []string{"account"}, CompletenessConfirmed: true},
		{ID: "two", SourceID: "source", HubID: "hub", ObservedAt: start.Add(time.Hour), TokenCount: 250, APICostUSDText: "2.5", ModelTokens: map[string]int64{"gpt-5": 160, "claude": 90}, ModelCosts: map[string]string{"gpt-5": "1.6", "claude": "0.9"}, AccountIDs: []string{"account"}, CompletenessConfirmed: true},
	}}
	service, err := NewUsageServiceWithDependencies(reader, usageTestClock{now: start.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.GetUsage(context.Background(), UsageFilterInput{From: start.Format(time.RFC3339), To: start.Add(2 * time.Hour).Format(time.RFC3339), DisplayTimeZone: "UTC", GroupBy: "model"})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("model grouping preserves every observed model", func(t *testing.T) {
		if len(result.Breakdown) != 2 || result.Breakdown[0].Tokens+result.Breakdown[1].Tokens != result.Summary.Tokens || result.Summary.Tokens != 150 || len(result.Series) != 1 || len(result.Series[0].Breakdown) != 2 {
			t.Fatalf("model breakdown = %#v, summary = %#v", result.Breakdown, result.Summary)
		}
	})
}

func TestUsageServiceP2VIS01AdvancedFiltersKeepSharedObservationOnce(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	reader := usageTestReader{observations: []domain.UsageObservation{
		{ID: "advanced-start", SourceID: "advanced-source", HubID: "hub", HubName: "Hub", DeviceID: "record", CollectionDeviceID: "collector", RawServiceIdentifier: "raw", ServiceID: "service", ObservedAt: start, TokenCount: 100, APICostUSDText: "1", AccountIDs: []string{"account-a", "account-b"}, AccountNames: []string{"A", "B"}, PlanVersionIDs: []string{"plan-version"}, LimitDefinitionIDs: []string{"limit-definition"}, CompletenessConfirmed: true},
		{ID: "advanced-end", SourceID: "advanced-source", HubID: "hub", HubName: "Hub", DeviceID: "record", CollectionDeviceID: "collector", RawServiceIdentifier: "raw", ServiceID: "service", ObservedAt: start.Add(time.Hour), TokenCount: 250, APICostUSDText: "2.5", AccountIDs: []string{"account-a", "account-b"}, AccountNames: []string{"A", "B"}, PlanVersionIDs: []string{"plan-version"}, LimitDefinitionIDs: []string{"limit-definition"}, CompletenessConfirmed: true},
	}}
	service, err := NewUsageServiceWithDependencies(reader, usageTestClock{now: start.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	input := UsageFilterInput{From: start.Format(time.RFC3339), To: start.Add(2 * time.Hour).Format(time.RFC3339), DisplayTimeZone: "UTC", CollectionDeviceID: "collector", DeviceID: "record", ServiceID: "service", RawServiceIdentifier: "raw", LogicalAccountID: "account-a", PlanVersionID: "plan-version", LimitDefinitionID: "limit-definition"}
	result, err := service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary.Tokens != 150 || result.Summary.SharedTokens != 150 || result.Summary.ObservationCount != 1 || len(result.Evidence) != 1 {
		t.Fatalf("P2-VIS-01 advanced filters duplicated or dropped shared observation: %#v", result)
	}
	input.PlanVersionID = "other-plan-version"
	result, err = service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Summary.ObservationCount != 0 {
		t.Fatalf("P2-VIS-01 unmatched plan version selected observations: %#v", result.Summary)
	}
	input.PlanVersionID = "plan-version"
	input.GroupBy = "collectionDevice"
	result, err = service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Breakdown) != 1 || result.Breakdown[0].Key != "collector:shared" {
		t.Fatalf("P2-USAGE-01 collection device breakdown = %#v", result.Breakdown)
	}
	input.GroupBy = "unknown"
	if _, err = service.GetUsage(context.Background(), input); err == nil {
		t.Fatal("unsupported usage classification was accepted")
	}
}

func TestUsageServiceUsesSharedClassificationForBothMetricsAndCompactsAfterTopFive(t *testing.T) {
	t.Parallel()
	rows := make([]UsageBreakdownSnapshot, 0, 7)
	for index, tokens := range []int64{50, 40, 30, 20, 10, 5, 4} {
		key := string(rune('a' + index))
		rows = append(rows, UsageBreakdownSnapshot{Key: key, CategoryKey: key, Label: key, Attribution: "単一アカウントに帰属する利用実績", Tokens: tokens, APICostUSD: float64(4 + index), APICostUSDText: strconv.Itoa(4 + index), ObservationCount: 1})
	}
	// Category g is small by tokens but dominant by cost, so it must be retained
	// by the equally weighted two-metric ranking. Categories e and f become "それ以外".
	rows[6].APICostUSD = 100
	rows[6].APICostUSDText = "100"
	compacted, series := compactUsageCategories(rows, []UsagePointSnapshot{{Breakdown: append([]UsageBreakdownSnapshot(nil), rows...)}}, 5)
	if len(compacted) != 6 || len(series) != 1 || len(series[0].Breakdown) != 6 {
		t.Fatalf("compacted rows = %#v series = %#v", compacted, series)
	}
	visible := make(map[string]UsageBreakdownSnapshot)
	for _, row := range compacted {
		visible[row.CategoryKey] = row
	}
	if _, ok := visible["g"]; !ok {
		t.Fatalf("cost-dominant category was hidden: %#v", compacted)
	}
	other, ok := visible["other"]
	if !ok || other.Label != "それ以外" || other.Tokens != 15 || other.APICostUSDText != "17" {
		t.Fatalf("other category = %#v", other)
	}
}

func TestUsageServiceSupportsContractAndObservedAgentClassifications(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	reader := usageTestReader{observations: []domain.UsageObservation{
		{ID: "one", SourceID: "source", HubID: "hub", RawServiceIdentifier: "codex", ObservedAt: start, TokenCount: 10, APICostUSDText: "1", AccountIDs: []string{"account"}, PlanVersionIDs: []string{"plan-v1"}, PlanVersionNames: []string{"Plus 2026"}, CompletenessConfirmed: true},
		{ID: "two", SourceID: "source", HubID: "hub", RawServiceIdentifier: "codex", ObservedAt: start.Add(time.Hour), TokenCount: 30, APICostUSDText: "3", AccountIDs: []string{"account"}, PlanVersionIDs: []string{"plan-v1"}, PlanVersionNames: []string{"Plus 2026"}, CompletenessConfirmed: true},
	}}
	service, err := NewUsageServiceWithDependencies(reader, usageTestClock{now: start.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	input := UsageFilterInput{From: start.Format(time.RFC3339), To: start.Add(2 * time.Hour).Format(time.RFC3339), DisplayTimeZone: "UTC", GroupBy: "contract"}
	contract, err := service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(contract.Breakdown) != 1 || contract.Breakdown[0].CategoryKey != "plan-v1" || contract.Breakdown[0].Label != "Plus 2026" {
		t.Fatalf("contract breakdown = %#v", contract.Breakdown)
	}
	input.GroupBy = "agent"
	agent, err := service.GetUsage(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if len(agent.Breakdown) != 1 || agent.Breakdown[0].CategoryKey != "codex" || agent.Breakdown[0].Label != "codex" {
		t.Fatalf("agent breakdown = %#v", agent.Breakdown)
	}
}
