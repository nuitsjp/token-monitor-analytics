package usecase

import (
	"context"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

// RecalculationStore owns the claim and derived-result transaction. Keeping
// Recalculate on this port prevents the worker from reaching the interval
// persistence path.
type RecalculationStore interface {
	ClaimRecalculationRequest(context.Context, string) (domain.RecalculationRequest, bool, error)
	Recalculate(context.Context, domain.RecalculationRequest) error
	CompleteRecalculationRequest(context.Context, string) error
	FailRecalculationRequest(context.Context, string, string) error
}

type RecalculationWorker struct {
	store    RecalculationStore
	workerID string
}

func NewRecalculationWorker(store RecalculationStore, workerID string) (*RecalculationWorker, error) {
	if store == nil || workerID == "" {
		return nil, errors.New("recalculation worker dependencies are required")
	}
	return &RecalculationWorker{store: store, workerID: workerID}, nil
}

// RunOnce atomically claims one pending request. It returns false when the
// queue is empty; a failed calculation is persisted as failed before returning
// the calculation error.
func (w *RecalculationWorker) RunOnce(ctx context.Context) (bool, error) {
	request, claimed, err := w.store.ClaimRecalculationRequest(ctx, w.workerID)
	if err != nil || !claimed {
		return claimed, err
	}
	if err := w.store.Recalculate(ctx, request); err != nil {
		failure := err.Error()
		if markErr := w.store.FailRecalculationRequest(ctx, request.RequestID, failure); markErr != nil {
			return true, fmt.Errorf("recalculation failed: %v; mark failed: %w", failure, markErr)
		}
		return true, err
	}
	if err := w.store.CompleteRecalculationRequest(ctx, request.RequestID); err != nil {
		return true, fmt.Errorf("complete recalculation request: %w", err)
	}
	return true, nil
}
