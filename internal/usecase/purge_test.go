package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type purgeFakeStore struct {
	preview domain.PurgePreview
	result  domain.PurgeResult
	seen    domain.PurgeSelection
	when    time.Time
}

func (s *purgeFakeStore) Capacity(context.Context) (domain.DataCapacity, error) {
	return domain.DataCapacity{}, nil
}

func (s *purgeFakeStore) PreviewPurge(_ context.Context, selection domain.PurgeSelection) (domain.PurgePreview, error) {
	s.seen = selection
	return s.preview, nil
}

func (s *purgeFakeStore) Purge(_ context.Context, selection domain.PurgeSelection, executedAt time.Time) (domain.PurgeResult, error) {
	s.seen, s.when = selection, executedAt
	return s.result, nil
}

type purgeFakeClock struct{ now time.Time }

func (c purgeFakeClock) Now() time.Time { return c.now }

func TestPurgeUsecaseRequiresConfirmationAndUsesMaintenanceGate(t *testing.T) {
	now := time.Date(2026, 8, 26, 3, 4, 5, 0, time.UTC)
	store := &purgeFakeStore{result: domain.PurgeResult{AuditID: "audit"}}
	usecase, err := NewPurgeUsecase(store, purgeFakeClock{now: now}, NewMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	selection := domain.PurgeSelection{HubIDs: []string{"hub"}}
	if _, err := usecase.Purge(context.Background(), selection, false); err == nil {
		t.Fatal("unconfirmed purge succeeded")
	}
	result, err := usecase.Purge(context.Background(), selection, true)
	if err != nil || result.AuditID != "audit" || !store.when.Equal(now) {
		t.Fatalf("purge result = %#v, error = %v, execution = %v", result, err, store.when)
	}
}

func TestPurgeUsecaseRejectsEmptySelectionBeforeStore(t *testing.T) {
	store := &purgeFakeStore{}
	usecase, err := NewPurgeUsecase(store, purgeFakeClock{now: time.Now()}, NewMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	_, err = usecase.Preview(context.Background(), domain.PurgeSelection{})
	if !errors.Is(err, domain.ErrPurgeSelectionHubs) {
		t.Fatalf("preview error = %v", err)
	}
}
