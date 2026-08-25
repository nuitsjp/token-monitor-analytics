package usecase

import (
	"context"
	"errors"
	"testing"

	"token-monitor-analytics/internal/domain"
)

type recalculationTestStore struct {
	request        domain.RecalculationRequest
	claim          bool
	recalculateErr error
	state          string
	failedID       string
	completedID    string
}

func (s *recalculationTestStore) ClaimRecalculationRequest(context.Context, string) (domain.RecalculationRequest, bool, error) {
	if !s.claim {
		return domain.RecalculationRequest{}, false, nil
	}
	s.claim = false
	s.state = "running"
	return s.request, true, nil
}

func (s *recalculationTestStore) Recalculate(context.Context, domain.RecalculationRequest) error {
	return s.recalculateErr
}

func (s *recalculationTestStore) CompleteRecalculationRequest(_ context.Context, requestID string) error {
	s.state = "succeeded"
	s.completedID = requestID
	return nil
}

func (s *recalculationTestStore) FailRecalculationRequest(_ context.Context, requestID, _ string) error {
	s.state = "failed"
	s.failedID = requestID
	return nil
}

func TestRecalculationWorkerMarksFailedCalculation(t *testing.T) {
	store := &recalculationTestStore{request: domain.RecalculationRequest{RequestID: "request-failed"}, claim: true, recalculateErr: errors.New("calculation failed")}
	worker, err := NewRecalculationWorker(store, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := worker.RunOnce(context.Background())
	if !claimed || err == nil || store.state != "failed" || store.failedID != "request-failed" {
		t.Fatalf("failed worker run: claimed=%v err=%v state=%q failedID=%q", claimed, err, store.state, store.failedID)
	}
}

func TestRecalculationWorkerMarksSuccessfulCalculation(t *testing.T) {
	store := &recalculationTestStore{request: domain.RecalculationRequest{RequestID: "request-succeeded"}, claim: true}
	worker, err := NewRecalculationWorker(store, "worker-1")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := worker.RunOnce(context.Background())
	if !claimed || err != nil || store.state != "succeeded" || store.completedID != "request-succeeded" {
		t.Fatalf("successful worker run: claimed=%v err=%v state=%q completedID=%q", claimed, err, store.state, store.completedID)
	}
}
