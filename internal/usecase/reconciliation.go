package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

type ReconciliationStore interface {
	ReconcileObservedConfiguration(context.Context, string, time.Time) (domain.ReconciliationSummary, error)
}

// ReconciliationUsecase fills only deterministic configuration gaps. It does
// not merge accounts across Hubs and does not infer an unknown formal plan.
type ReconciliationUsecase struct {
	store ReconciliationStore
	clock Clock
}

func NewReconciliationUsecase(store ReconciliationStore, clock Clock) (*ReconciliationUsecase, error) {
	if store == nil || clock == nil {
		return nil, errors.New("reconciliation dependencies are required")
	}
	return &ReconciliationUsecase{store: store, clock: clock}, nil
}

func (u *ReconciliationUsecase) Reconcile(ctx context.Context, hubID string) (domain.ReconciliationSummary, error) {
	if u == nil {
		return domain.ReconciliationSummary{}, errors.New("reconciliation usecase is unavailable")
	}
	summary, err := u.store.ReconcileObservedConfiguration(ctx, hubID, u.clock.Now().UTC())
	if err != nil {
		return domain.ReconciliationSummary{}, fmt.Errorf("reconcile observed configuration: %w", err)
	}
	return summary, nil
}
