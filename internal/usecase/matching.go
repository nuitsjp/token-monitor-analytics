package usecase

import (
	"context"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

type EstimationPointStore interface {
	ListCalculationMatchingInputs(context.Context, domain.CalculationBuildRequest) ([]domain.CalculationMatchingInput, error)
	SaveEstimationPoints(context.Context, []domain.EstimationPoint) error
}

type EstimationPointUsecase struct {
	store EstimationPointStore
	clock Clock
	ids   IDGenerator
}

func NewEstimationPointUsecase(store EstimationPointStore, clock Clock, ids IDGenerator) (*EstimationPointUsecase, error) {
	if store == nil || clock == nil || ids == nil {
		return nil, errors.New("estimation point usecase dependencies are required")
	}
	return &EstimationPointUsecase{store: store, clock: clock, ids: ids}, nil
}

func (u *EstimationPointUsecase) BuildEstimationPoints(ctx context.Context, request domain.CalculationBuildRequest) ([]domain.EstimationPoint, error) {
	if err := request.Validate(); err != nil {
		return nil, err
	}
	inputs, err := u.store.ListCalculationMatchingInputs(ctx, request)
	if err != nil {
		return nil, fmt.Errorf("read matching observations: %w", err)
	}
	now := u.clock.Now().UTC()
	points := make([]domain.EstimationPoint, 0)
	for _, input := range inputs {
		derived, deriveErr := domain.BuildEstimationPoints(input, u.ids.New, now)
		if deriveErr != nil {
			return nil, fmt.Errorf("build estimation points: %w", deriveErr)
		}
		points = append(points, derived...)
	}
	if len(points) != 0 {
		if err := u.store.SaveEstimationPoints(ctx, points); err != nil {
			return nil, fmt.Errorf("save estimation points: %w", err)
		}
	}
	return points, nil
}
