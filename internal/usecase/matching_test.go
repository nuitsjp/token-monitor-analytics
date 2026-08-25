package usecase

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type matchingStore struct {
	inputs []domain.CalculationMatchingInput
	reads  int
	saved  []domain.EstimationPoint
}

func (s *matchingStore) ListCalculationMatchingInputs(context.Context, domain.CalculationBuildRequest) ([]domain.CalculationMatchingInput, error) {
	s.reads++
	return s.inputs, nil
}

func (s *matchingStore) SaveEstimationPoints(_ context.Context, points []domain.EstimationPoint) error {
	s.saved = append([]domain.EstimationPoint(nil), points...)
	return nil
}

type matchingClock struct{ value time.Time }

func (c matchingClock) Now() time.Time { return c.value }

type matchingIDs struct{ next int }

func (g *matchingIDs) New() string {
	g.next++
	return "usecase-matching-id-" + time.Duration(g.next).String()
}

func TestT031EstimationPointUsecaseInjectsClockAndIDs(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	sync := int64(0)
	refresh := int64(1)
	used := 25.0
	store := &matchingStore{inputs: []domain.CalculationMatchingInput{{
		ServiceID: "service", LimitDefinitionID: "definition", PlanVersionID: "plan", CycleType: domain.LimitCycleWeekly,
		CalculationIntervalIDs: []string{"interval"}, ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), Eligible: true,
		LimitSeries: []domain.MatchingLimitSeries{{CalculationIntervalID: "interval", LogicalAccountID: "account", UsageLimitSourceID: "limit-source", Observations: []domain.MatchingLimitObservation{{ID: "limit-observation", ObservedAt: now, UsedPercent: &used, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, LimitsRefreshMS: &refresh, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", DedupeState: "canonical"}}}},
		CostSources: []domain.MatchingCostSource{{UsageCostSourceID: "cost-source", Complete: true, Observations: []domain.MatchingCostObservation{{ID: "cost-observation", ObservedAt: now, ValueText: "12", APIContractSupported: true, AnalyticsIntervalSeconds: 1, SyncUploadIntervalMS: &sync, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", DedupeState: "canonical"}}}},
	}}}
	usecase, err := NewEstimationPointUsecase(store, matchingClock{value: now}, &matchingIDs{})
	if err != nil {
		t.Fatal(err)
	}
	points, err := usecase.BuildEstimationPoints(context.Background(), domain.CalculationBuildRequest{ServiceID: "service", ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].ID == "" || !points[0].CreatedAt.Equal(now) || points[0].SharedCost != 12 || points[0].Utilization[0] != 0.25 {
		t.Fatalf("points = %#v", points)
	}
	if store.reads != 1 || len(store.saved) != 1 {
		t.Fatalf("store calls reads=%d saved=%d", store.reads, len(store.saved))
	}
}

func TestT031EstimationPointUsecaseRejectsInvalidRequestBeforeStore(t *testing.T) {
	store := &matchingStore{}
	usecase, err := NewEstimationPointUsecase(store, matchingClock{value: time.Now()}, &matchingIDs{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := usecase.BuildEstimationPoints(context.Background(), domain.CalculationBuildRequest{ServiceID: "service"}); err == nil {
		t.Fatal("invalid request was accepted")
	}
	if store.reads != 0 {
		t.Fatalf("store was read %d times", store.reads)
	}
}
