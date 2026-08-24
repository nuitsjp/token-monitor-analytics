package analytics

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseAndCalculateUsesProviderCostForExactPeriod(t *testing.T) {
	raw := []byte(`{"periods":{"weekly":{"costUsd":800,"clientCosts":{"claude":800}}},"limits":{"providers":[{"provider":"claude","accountKey":"sha256:a","windows":[{"kind":"weekly","usedPercent":40,"resetsAt":"2026-08-25T00:00:00Z"}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Observations) != 1 {
		t.Fatalf("got %d observations", len(result.Observations))
	}
	observation := result.Observations[0]
	if observation.UsageUSD != 800 || observation.EstimatedLimitUSD != 2000 {
		t.Fatalf("unexpected calculation: %+v", observation)
	}
	if observation.CalculationStatus != "ok" {
		t.Fatalf("expected ok, got %q", observation.CalculationStatus)
	}
	if observation.PeriodStart != "2026-08-18T00:00:00Z" {
		t.Fatalf("unexpected period start: %q", observation.PeriodStart)
	}
}

func TestParseAndCalculateRetainsPartialCostWithoutEstimate(t *testing.T) {
	raw := []byte(`{"periods":{"today":{"costUsd":800,"clientCosts":{"claude":800}}},"limits":{"providers":[{"provider":"claude","accountKey":"sha256:a","windows":[{"kind":"weekly","usedPercent":40,"resetsAt":"2026-08-25T00:00:00Z"}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Date(2026, 8, 23, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	observation := result.Observations[0]
	if observation.UsageUSD != 800 || observation.EstimatedLimitUSD != 0 || observation.UtilizationPercent != 40 {
		t.Fatalf("partial observation must retain reference cost/rate only: %+v", observation)
	}
	if observation.CalculationStatus != "partial_period" {
		t.Fatalf("expected partial_period, got %q", observation.CalculationStatus)
	}
}

func TestParseAndCalculateUsesObservedMonthStartForBillingPeriod(t *testing.T) {
	raw := []byte(`{"periods":{"month":{"clientCosts":{"claude":300}}},"limits":{"providers":[{"provider":"claude","accountKey":"sha256:a","windows":[{"kind":"billing","usedPercent":30,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	observation := result.Observations[0]
	if observation.PeriodStart != "2026-08-01T00:00:00Z" || observation.PeriodEnd != "2026-09-01T00:00:00Z" {
		t.Fatalf("unexpected billing period: %+v", observation)
	}
	if observation.CalculationStatus != "ok" || observation.EstimatedLimitUSD != 1000 {
		t.Fatalf("unexpected billing estimate: %+v", observation)
	}
}

func TestParseAndCalculateDoesNotUseMonthForWeeklyWhenTodayMissing(t *testing.T) {
	raw := []byte(`{"periods":{"month":{"costUsd":2000}},"limits":{"providers":[{"provider":"codex","windows":[{"kind":"weekly","usedPercent":40}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if result.Observations[0].CalculationStatus != "missing_period" || result.Observations[0].EstimatedLimitUSD != 0 {
		t.Fatalf("unexpected observation: %+v", result.Observations[0])
	}
}

func TestUtilizationPercentSupportsFractionAndPercentForms(t *testing.T) {
	usedFraction := 0.8
	remainingFraction := 0.8
	usedPercent := 40.0
	remainingPercent := 60.0
	for _, test := range []struct {
		name     string
		window   Window
		expected float64
	}{
		{name: "used fraction", window: Window{UsedPercent: &usedFraction}, expected: 80},
		{name: "remaining fraction", window: Window{RemainingPercent: &remainingFraction}, expected: 20},
		{name: "used percent", window: Window{UsedPercent: &usedPercent}, expected: 40},
		{name: "remaining percent", window: Window{RemainingPercent: &remainingPercent}, expected: 40},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := utilizationPercent(test.window); got != test.expected {
				t.Fatalf("got %v, want %v", got, test.expected)
			}
		})
	}
}

func TestParseAndCalculateRequiresProviderClientCost(t *testing.T) {
	raw := []byte(`{"periods":{"weekly":{"costUsd":800}},"limits":{"providers":[{"provider":"codex","windows":[{"kind":"weekly","usedPercent":40}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	observation := result.Observations[0]
	if observation.CalculationStatus != "missing_provider_cost" || observation.UsageUSD != 0 || observation.EstimatedLimitUSD != 0 {
		t.Fatalf("period total must not be attributed to provider: %+v", observation)
	}
}

func TestParseAndCalculateStopsEstimateForMultipleProviderAccounts(t *testing.T) {
	raw := []byte(`{"periods":{"weekly":{"clientCosts":{"codex":800}}},"limits":{"providers":[{"provider":"codex","accountKey":"sha256:a","windows":[{"kind":"weekly","usedPercent":40}]},{"provider":"codex","accountKey":"sha256:b","windows":[{"kind":"weekly","usedPercent":40}]}]}}`)
	result, err := ParseAndCalculate(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Observations) != 2 {
		t.Fatalf("got %d observations", len(result.Observations))
	}
	for _, observation := range result.Observations {
		if observation.CalculationStatus != "ambiguous_account_cost" || observation.EstimatedLimitUSD != 0 || observation.UsageUSD != 0 {
			t.Fatalf("provider total must not be duplicated across accounts: %+v", observation)
		}
	}
}

func TestFetchStatsUsesBearerAuth(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/stats" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"periods":{},"limits":{"providers":[]}}`))
	}))
	defer server.Close()
	body, _, err := FetchStats(context.Background(), server.Client(), server.URL, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "periods") {
		t.Fatalf("unexpected body %s", body)
	}
}

func TestAnalyzeStatsBuildsMonthlyBreakdowns(t *testing.T) {
	raw := []byte(`{
"periods":{"month":{"totalTokens":300,"costUsd":6,"clients":{"codex":200,"claude":100},"clientCosts":{"codex":4,"claude":2},"models":{"gpt-5":200},"modelCosts":{"gpt-5":4}}},
"limits":{"providers":[{"provider":"codex","accountKey":"a"},{"provider":"claude","accountKey":"b"}]},
"devices":[{"deviceId":"device-1","hostname":"desktop","periods":{"month":{"totalTokens":300,"costUsd":6}}}]
}`)
	analysis, err := AnalyzeStats(raw, "month")
	if err != nil {
		t.Fatal(err)
	}
	if analysis.TotalCostUSD != 6 || analysis.ProviderCosts["codex"] != 4 || analysis.ProviderAccountCounts["codex"] != 1 {
		t.Fatalf("unexpected analysis: %+v", analysis)
	}
	counts := map[string]int{}
	for _, row := range analysis.Breakdowns {
		counts[row.Dimension]++
	}
	if counts["tool"] != 2 || counts["model"] != 1 || counts["device"] != 1 {
		t.Fatalf("unexpected breakdown counts: %+v", counts)
	}
}
