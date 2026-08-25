package usecase

import (
	"context"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

// CalculationStore is the T-030 port for reading confirmed facts and saving
// the derived calculation intervals in one adapter transaction.
type CalculationStore interface {
	ListCalculationSeries(context.Context, domain.CalculationBuildRequest) ([]domain.CalculationSeries, error)
	SaveCalculationIntervals(context.Context, []domain.CalculationInterval, []domain.CalculationBoundary) error
}

type CalculationUsecase struct {
	store CalculationStore
	clock Clock
	ids   IDGenerator
}

func NewCalculationUsecase(store CalculationStore, clock Clock, ids IDGenerator) (*CalculationUsecase, error) {
	if store == nil || clock == nil || ids == nil {
		return nil, errors.New("calculation usecase dependencies are required")
	}
	return &CalculationUsecase{store: store, clock: clock, ids: ids}, nil
}

func (u *CalculationUsecase) BuildCalculationIntervals(ctx context.Context, request domain.CalculationBuildRequest) ([]domain.CalculationInterval, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	series, err := u.store.ListCalculationSeries(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("read calculation facts: %w", err)
	}
	now := u.clock.Now().UTC()
	intervals := make([]domain.CalculationInterval, 0)
	boundaries := make([]domain.CalculationBoundary, 0)
	for _, item := range series {
		derived, derivedBoundaries, err := domain.DeriveCalculationIntervals(item, request, u.ids.New, now)
		if err != nil {
			return nil, fmt.Errorf("derive calculation intervals: %w", err)
		}
		intervals = append(intervals, derived...)
		boundaries = append(boundaries, derivedBoundaries...)
	}
	if len(intervals) != 0 || len(boundaries) != 0 {
		if err := u.store.SaveCalculationIntervals(ctx, intervals, boundaries); err != nil {
			return nil, fmt.Errorf("save calculation intervals: %w", err)
		}
	}
	return intervals, nil
}
