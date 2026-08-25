package usecase

import (
	"context"
	"errors"
	"time"

	"token-monitor-analytics/internal/domain"
)

type PurgeStore interface {
	Capacity(context.Context) (domain.DataCapacity, error)
	PreviewPurge(context.Context, domain.PurgeSelection) (domain.PurgePreview, error)
	Purge(context.Context, domain.PurgeSelection, time.Time) (domain.PurgeResult, error)
}

type PurgeGate interface {
	Acquire(context.Context, MaintenanceOperation) (*MaintenanceLease, error)
}

type PurgeUsecase struct {
	store PurgeStore
	clock Clock
	gate  PurgeGate
}

func NewPurgeUsecase(store PurgeStore, clock Clock, gate PurgeGate) (*PurgeUsecase, error) {
	if store == nil || clock == nil || gate == nil {
		return nil, errors.New("purge usecase dependencies are required")
	}
	return &PurgeUsecase{store: store, clock: clock, gate: gate}, nil
}

func (u *PurgeUsecase) Preview(ctx context.Context, selection domain.PurgeSelection) (domain.PurgePreview, error) {
	selection, err := selection.Normalized()
	if err != nil {
		return domain.PurgePreview{}, err
	}
	return u.store.PreviewPurge(ctx, selection)
}

func (u *PurgeUsecase) Capacity(ctx context.Context) (domain.DataCapacity, error) {
	return u.store.Capacity(ctx)
}

func (u *PurgeUsecase) Purge(ctx context.Context, selection domain.PurgeSelection, confirmed bool) (domain.PurgeResult, error) {
	if !confirmed {
		return domain.PurgeResult{}, errors.New("purge confirmation is required")
	}
	selection, err := selection.Normalized()
	if err != nil {
		return domain.PurgeResult{}, err
	}
	lease, err := u.gate.Acquire(ctx, MaintenancePurge)
	if err != nil {
		return domain.PurgeResult{}, err
	}
	defer lease.Release()
	return u.store.Purge(ctx, selection, u.clock.Now().UTC())
}
