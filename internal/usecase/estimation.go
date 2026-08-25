package usecase

import (
	"context"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

type EstimationInputStore interface {
	ListEstimationInput(context.Context, string) (domain.EstimationInput, error)
}

type EstimationUsecase struct {
	store EstimationInputStore
}

func NewEstimationUsecase(store EstimationInputStore) (*EstimationUsecase, error) {
	if store == nil {
		return nil, errors.New("estimation usecase dependencies are required")
	}
	return &EstimationUsecase{store: store}, nil
}

func (u *EstimationUsecase) Estimate(ctx context.Context, calculationIntervalID string) (domain.EstimationResult, error) {
	input, err := u.store.ListEstimationInput(ctx, calculationIntervalID)
	if err != nil {
		return domain.EstimationResult{}, fmt.Errorf("read estimation input: %w", err)
	}
	result, err := domain.EstimateFromPoints(input)
	if err != nil {
		return domain.EstimationResult{}, fmt.Errorf("estimate calculation interval: %w", err)
	}
	return result, nil
}
