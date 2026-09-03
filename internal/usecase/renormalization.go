package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

type RenormalizationStore interface {
	ListRawStatsForNormalization(context.Context, int64) ([]domain.RawNormalizationInput, error)
	InsertAllObservations(context.Context, []domain.CostObservation, []domain.CollectionUsageObservation, []domain.LimitObservation, []domain.CollectionUsagePeriodObservation) error
	CompleteNormalization(context.Context, string, int64, string, string, time.Time, time.Time, string) error
}

type RenormalizationUsecase struct {
	store        RenormalizationStore
	clock        Clock
	ids          IDGenerator
	dependencies CollectionDependencies
}

func NewRenormalizationUsecase(store RenormalizationStore, clock Clock, ids IDGenerator, dependencies CollectionDependencies) (*RenormalizationUsecase, error) {
	if store == nil || clock == nil || ids == nil || dependencies.NormalizeStats == nil || dependencies.NormalizationGeneration <= 0 || dependencies.NormalizationRuleVersion == "" || dependencies.NormalizationLogicVersion == "" {
		return nil, errors.New("renormalization dependencies are required")
	}
	return &RenormalizationUsecase{store: store, clock: clock, ids: ids, dependencies: dependencies}, nil
}

func (u *RenormalizationUsecase) Run(ctx context.Context) (int, error) {
	inputs, err := u.store.ListRawStatsForNormalization(ctx, u.dependencies.NormalizationGeneration)
	if err != nil {
		return 0, fmt.Errorf("list raw snapshots for renormalization: %w", err)
	}
	completed := 0
	for _, input := range inputs {
		started := u.clock.Now().UTC()
		normalized, normalizeErr := u.dependencies.NormalizeStats(input.Body)
		if normalizeErr != nil {
			finished := u.clock.Now().UTC()
			if err := u.store.CompleteNormalization(ctx, input.SnapshotID, u.dependencies.NormalizationGeneration, u.dependencies.NormalizationRuleVersion, u.dependencies.NormalizationLogicVersion, started, finished, "normalization failed"); err != nil {
				return completed, err
			}
			continue
		}
		batch := buildObservationBatch(normalized, input.SnapshotID, input.HubID, input.AnalyticsIntervalSeconds, u.ids, u.dependencies)
		if err := u.store.InsertAllObservations(ctx, batch.costs, batch.usage, batch.limits, batch.periods); err != nil {
			return completed, fmt.Errorf("insert renormalized observations for snapshot %s: %w", input.SnapshotID, err)
		}
		finished := u.clock.Now().UTC()
		if err := u.store.CompleteNormalization(ctx, input.SnapshotID, u.dependencies.NormalizationGeneration, u.dependencies.NormalizationRuleVersion, u.dependencies.NormalizationLogicVersion, started, finished, ""); err != nil {
			return completed, err
		}
		completed++
	}
	return completed, nil
}
