package usecase

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type estimationInputStore struct {
	input domain.EstimationInput
	id    string
}

func (s *estimationInputStore) ListEstimationInput(_ context.Context, id string) (domain.EstimationInput, error) {
	s.id = id
	return s.input, nil
}

func TestEstimationUsecaseEstimatesPersistedInput(t *testing.T) {
	at := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	point := func(id string, cost, utilization float64, at time.Time) domain.EstimationPoint {
		return domain.EstimationPoint{ID: id, ServiceID: "service", LimitDefinitionID: "definition", CycleType: domain.LimitCycleWeekly, CalculationIntervalID: "interval", CalculationIntervalIDs: []string{"interval"}, ReferenceAt: at, SharedCost: cost, Utilization: []float64{utilization}, LimitSeriesIDs: []string{"limit"}, LimitSeriesLogicalAccountIDs: []string{"account"}, LimitSeriesPlanVersionIDs: []string{"plan-version"}, LimitSeriesCalculationIntervalIDs: []string{"interval"}, CostSourceIDs: []string{"cost"}, MatchingRuleVersion: domain.MatchingRuleVersion, CalculationLogicVersion: domain.CalculationLogicVersion, CreatedAt: at, UpdatedAt: at}
	}
	store := &estimationInputStore{input: domain.EstimationInput{
		Points:    []domain.EstimationPoint{point("point-1", 0, 0.1, at), point("point-2", 10, 0.2, at.Add(time.Hour))},
		Intervals: []domain.CalculationInterval{{ID: "interval", State: domain.CalculationEstimable}},
	}}
	usecase, err := NewEstimationUsecase(store)
	if err != nil {
		t.Fatal(err)
	}
	result, err := usecase.Estimate(context.Background(), "interval")
	if err != nil {
		t.Fatal(err)
	}
	if store.id != "interval" || result.Status != domain.EstimationProvisional {
		t.Fatalf("id=%q result=%#v", store.id, result)
	}
}

func TestNewEstimationUsecaseRequiresStore(t *testing.T) {
	if _, err := NewEstimationUsecase(nil); err == nil {
		t.Fatal("expected dependency error")
	}
}
