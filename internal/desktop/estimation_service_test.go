package desktop

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type estimationServiceReader struct {
	series  []domain.LimitSeriesView
	results []domain.DerivedResult
	history []domain.CalculationIntervalView
}

func (r *estimationServiceReader) ListCurrentLimitSeries(context.Context, time.Time) ([]domain.LimitSeriesView, error) {
	return r.series, nil
}

func (r *estimationServiceReader) ListEstimationResults(context.Context, string) ([]domain.DerivedResult, error) {
	return r.results, nil
}

func (r *estimationServiceReader) ListCalculationIntervalViews(context.Context, string, string, string, string) ([]domain.CalculationIntervalView, error) {
	return r.history, nil
}

func TestEstimationServiceKeepsUncomputedSeriesAndUsesGoDisplayValues(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	used := 25.5
	remaining := 74.5
	planLimit := 1000.0
	interval := &domain.CalculationIntervalView{ID: "interval-1", ServiceID: "service-1", LogicalAccountID: "account-1", UsageLimitSourceID: "source-1", LimitDefinitionID: "definition-1", CycleType: "weekly", ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), State: "estimable"}
	reader := &estimationServiceReader{
		series: []domain.LimitSeriesView{
			{ID: "series-1", ServiceID: "service-1", ServiceName: "Service", LogicalAccountID: "account-1", LogicalAccountName: "Account", LimitDefinitionID: "definition-1", LimitDefinitionName: "Weekly", CycleType: "weekly", UsageLimitSourceID: "source-1", NormalizedMetric: "percent", PlanVersionID: "plan-version-1", PlanVersionName: "Plan", PlanLimitRuleID: "rule-1", PlanLimit: &planLimit, UsedPercent: &used, RemainingPercent: &remaining, LatestObservationAt: timePointer(now.Add(-time.Minute)), Interval: interval},
			{ID: "series-2", ServiceID: "service-1", ServiceName: "Service", LogicalAccountID: "account-2", LogicalAccountName: "Account 2", LimitDefinitionID: "definition-1", LimitDefinitionName: "Weekly", CycleType: "weekly", UsageLimitSourceID: "source-2", NormalizedMetric: "percent", PlanVersionID: "plan-version-1", PlanVersionName: "Plan", PlanLimitRuleID: "rule-1", Interval: interval},
		},
		results: []domain.DerivedResult{{ID: "result-1", ServiceID: "service-1", LimitDefinitionID: "definition-1", CycleType: "weekly", CalculationIntervalIDs: []string{"interval-1"}, ValidFrom: interval.ValidFrom, ValidTo: interval.ValidTo, EstimationResult: domain.EstimationResult{Status: domain.EstimationProvisional, Reasons: []string{"exactly_identified"}, Limits: []float64{123}}, Series: []domain.EstimationResultSeries{{UsageLimitSourceID: "source-1", LogicalAccountID: "account-1", PlanVersionID: "plan-version-1", EstimatedLimit: floatPointer(123)}}}},
	}
	service, err := NewEstimationServiceWithDependencies(reader, fixedClock{value: now})
	if err != nil {
		t.Fatal(err)
	}
	items, err := service.GetLimitSeries(context.Background(), LimitSeriesFilterInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("series count = %d, want 2", len(items))
	}
	var computed LimitSeriesSnapshot
	var uncomputed LimitSeriesSnapshot
	for _, item := range items {
		if item.ID == "series-1" {
			computed = item
		}
		if item.ID == "series-2" {
			uncomputed = item
		}
	}
	if uncomputed.State.Code != "insufficient_observations" || uncomputed.StateReason == "" {
		t.Fatalf("insufficient series = %#v", uncomputed)
	}
	if computed.State.Code != "provisional" || computed.RemainingLabel != "74.5%" || computed.EstimatedLimitLabel != "123.00" {
		t.Fatalf("computed display = %#v", computed)
	}
}

func TestEstimationServiceStatePrecedenceFallbackAndFilters(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	rows := make([]domain.LimitSeriesView, 0, 8)
	results := make([]domain.DerivedResult, 0, 5)
	for index, status := range []domain.EstimationStatus{domain.EstimationNotApplicable, domain.EstimationUncomputed, domain.EstimationInsufficient, domain.EstimationUnidentifiable, domain.EstimationModelMismatch, domain.EstimationProvisional, domain.EstimationVerified} {
		interval := &domain.CalculationIntervalView{ID: "state-interval-" + string(rune('a'+index)), ServiceID: "state-service", LogicalAccountID: "state-account-" + string(rune('a'+index)), UsageLimitSourceID: "state-source-" + string(rune('a'+index)), LimitDefinitionID: "state-definition", CycleType: "weekly", ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), State: "estimable"}
		row := domain.LimitSeriesView{ID: "state-series-" + string(rune('a'+index)), ServiceID: "state-service", ServiceName: "State", LogicalAccountID: interval.LogicalAccountID, LogicalAccountName: interval.LogicalAccountID, LimitDefinitionID: "state-definition", LimitDefinitionName: "State", CycleType: "weekly", UsageLimitSourceID: interval.UsageLimitSourceID, NormalizedMetric: "percent", PlanVersionID: "state-plan", PlanLimitRuleID: "state-rule", UsedPercent: floatPointer(20), RemainingPercent: floatPointer(80), LatestObservationAt: timePointer(now.Add(-time.Minute)), Interval: interval}
		if status == domain.EstimationNotApplicable {
			row.NormalizedMetric = "credits"
		}
		if status == domain.EstimationUncomputed {
			row.PlanVersionID = ""
			row.PlanLimitRuleID = ""
		}
		if status == domain.EstimationInsufficient {
			row.LatestObservationAt = nil
			row.UsedPercent = nil
			row.RemainingPercent = nil
		}
		rows = append(rows, row)
		if status != domain.EstimationNotApplicable && status != domain.EstimationUncomputed && status != domain.EstimationInsufficient {
			results = append(results, domain.DerivedResult{ID: "state-result-" + string(rune('a'+index)), ServiceID: "state-service", LimitDefinitionID: "state-definition", CycleType: "weekly", CalculationIntervalIDs: []string{interval.ID}, ValidFrom: interval.ValidFrom, ValidTo: interval.ValidTo, EstimationResult: domain.EstimationResult{Status: status, Reasons: []string{"test_reason"}}, Series: []domain.EstimationResultSeries{{UsageLimitSourceID: row.UsageLimitSourceID, LogicalAccountID: row.LogicalAccountID, PlanVersionID: row.PlanVersionID, EstimatedLimit: floatPointer(999)}}})
		}
	}
	refInterval := &domain.CalculationIntervalView{ID: "ref-current", ServiceID: "state-service", LogicalAccountID: "ref-account", UsageLimitSourceID: "ref-source", LimitDefinitionID: "state-definition", CycleType: "weekly", ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), State: "estimable"}
	rows = append(rows, domain.LimitSeriesView{ID: "ref-series", ServiceID: "state-service", ServiceName: "State", LogicalAccountID: "ref-account", LogicalAccountName: "Reference", LimitDefinitionID: "state-definition", LimitDefinitionName: "State", CycleType: "weekly", UsageLimitSourceID: "ref-source", NormalizedMetric: "percent", PlanVersionID: "state-plan", PlanLimitRuleID: "state-rule", UsedPercent: floatPointer(10), RemainingPercent: floatPointer(90), LatestObservationAt: timePointer(now.Add(-time.Minute)), Interval: refInterval})
	results = append(results, domain.DerivedResult{ID: "old-ref", ServiceID: "state-service", LimitDefinitionID: "state-definition", CycleType: "weekly", ValidFrom: now.Add(-48 * time.Hour), ValidTo: now.Add(-24 * time.Hour), EstimationResult: domain.EstimationResult{Status: domain.EstimationVerified}, Series: []domain.EstimationResultSeries{{UsageLimitSourceID: "ref-source", LogicalAccountID: "ref-account", PlanVersionID: "state-plan"}}})
	results = append(results, domain.DerivedResult{ID: "wrong-plan", ServiceID: "state-service", LimitDefinitionID: "state-definition", CycleType: "weekly", ValidFrom: now.Add(-3 * time.Hour), ValidTo: now.Add(-time.Hour), EstimationResult: domain.EstimationResult{Status: domain.EstimationVerified}, Series: []domain.EstimationResultSeries{{UsageLimitSourceID: "ref-source", LogicalAccountID: "ref-account", PlanVersionID: "other-plan"}}})
	results = append(results, domain.DerivedResult{ID: "wrong-definition", ServiceID: "state-service", LimitDefinitionID: "other-definition", CycleType: "weekly", ValidFrom: now.Add(-3 * time.Hour), ValidTo: now.Add(-time.Hour), EstimationResult: domain.EstimationResult{Status: domain.EstimationVerified}, Series: []domain.EstimationResultSeries{{UsageLimitSourceID: "ref-source", LogicalAccountID: "ref-account", PlanVersionID: "state-plan"}}})
	reader := &estimationServiceReader{series: rows, results: results}
	service, err := NewEstimationServiceWithDependencies(reader, fixedClock{value: now})
	if err != nil {
		t.Fatal(err)
	}
	items, err := service.GetLimitSeries(context.Background(), LimitSeriesFilterInput{})
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, item := range items {
		states[item.ID] = item.State.Code
		if item.State.Code == "model_mismatch" && item.EstimatedLimit != nil {
			t.Fatal("model mismatch candidate became a primary estimated limit")
		}
	}
	want := []string{"not_applicable", "uncomputed", "insufficient_observations", "unidentifiable", "model_mismatch", "provisional", "verified"}
	for index, value := range want {
		if states["state-series-"+string(rune('a'+index))] != value {
			t.Fatalf("state %d = %q, want %q", index, states["state-series-"+string(rune('a'+index))], value)
		}
	}
	var reference LimitSeriesSnapshot
	for _, item := range items {
		if item.ID == "ref-series" {
			reference = item
		}
	}
	if reference.LatestValidReference == nil || reference.LatestValidReference.ResultID != "old-ref" {
		t.Fatalf("fallback reference = %#v", reference.LatestValidReference)
	}
	filtered, err := service.GetLimitSeries(context.Background(), LimitSeriesFilterInput{Status: "verified", PlanVersionID: "state-plan", SortBy: "remainingPercent"})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].ID != "state-series-g" {
		t.Fatalf("filtered/sorted series = %#v", filtered)
	}
}

func floatPointer(value float64) *float64 { return &value }
