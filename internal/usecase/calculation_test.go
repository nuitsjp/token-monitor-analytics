package usecase

import (
	"context"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type calculationUsecaseStore struct {
	series     []domain.CalculationSeries
	intervals  []domain.CalculationInterval
	boundaries []domain.CalculationBoundary
	reads      int
	saves      int
}

func (s *calculationUsecaseStore) ListCalculationSeries(context.Context, domain.CalculationBuildRequest) ([]domain.CalculationSeries, error) {
	s.reads++
	return s.series, nil
}

func (s *calculationUsecaseStore) SaveCalculationIntervals(_ context.Context, intervals []domain.CalculationInterval, boundaries []domain.CalculationBoundary) error {
	s.saves++
	s.intervals = intervals
	s.boundaries = boundaries
	return nil
}

type calculationUsecaseIDs struct{ next int }

func (g *calculationUsecaseIDs) New() string {
	g.next++
	return "injected-calculation-id-" + string(rune('a'+g.next))
}

func TestT030CalculationUsecaseInjectsIDsAndClock(t *testing.T) {
	now := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	end := now.Add(time.Hour)
	series := domain.CalculationSeries{
		ServiceID: "service", LogicalAccountID: "account", UsageLimitSourceID: "source", LimitDefinitionID: "definition", CycleType: domain.LimitCycleWeekly,
		Association:   domain.CalculationPeriod{ID: "link", ValidFrom: now, ValidTo: &end},
		Observations:  []domain.CalculationObservation{{ID: "start", ObservedAt: now, ResetAt: &now}, {ID: "end", ObservedAt: end, ResetAt: &end}},
		PlanHistories: []domain.PlanHistory{{ID: "history", LogicalAccountID: "account", PlanVersionID: "plan", ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}},
		CostSources:   []domain.CalculationCostSource{{ID: "cost", AssociationPeriods: []domain.CalculationPeriod{{ID: "cost-link", ValidFrom: now, ValidTo: &end}}, Completeness: []domain.CalculationCompleteness{{ID: "complete", ValidFrom: now, ValidTo: &end, State: domain.CompletenessConfirmed, LogicalAccountIDs: []string{"account"}}}}},
	}
	store := &calculationUsecaseStore{series: []domain.CalculationSeries{series}}
	ids := &calculationUsecaseIDs{}
	uc, err := NewCalculationUsecase(store, collectionTestClock{value: now}, ids)
	if err != nil {
		t.Fatal(err)
	}
	intervals, err := uc.BuildCalculationIntervals(context.Background(), domain.CalculationBuildRequest{ServiceID: "service", ValidFrom: now, ValidTo: end})
	if err != nil {
		t.Fatal(err)
	}
	if len(intervals) != 1 || !strings.HasPrefix(intervals[0].ID, "injected-calculation-id-") || !intervals[0].CreatedAt.Equal(now) || store.reads != 1 || store.saves != 1 {
		t.Fatalf("derived intervals=%#v store=%#v", intervals, store)
	}
}

func TestT030CalculationUsecaseRejectsInvalidRequestBeforeRead(t *testing.T) {
	store := &calculationUsecaseStore{}
	uc, err := NewCalculationUsecase(store, collectionTestClock{value: time.Now()}, &calculationUsecaseIDs{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uc.BuildCalculationIntervals(context.Background(), domain.CalculationBuildRequest{ServiceID: "service"}); err == nil {
		t.Fatal("invalid calculation request was accepted")
	}
	if store.reads != 0 || store.saves != 0 {
		t.Fatalf("invalid request reached store: %#v", store)
	}
}
