package scheduler

import (
	"context"
	"errors"
	"sync"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type HubSource interface {
	ListHubRows(context.Context) ([]sqliteadapter.HubRow, error)
	GetHubRow(context.Context, string) (sqliteadapter.HubRow, error)
	ListCredentialAuditEvents(context.Context, string) ([]sqliteadapter.CredentialAuditEvent, error)
}

// Scheduler owns only timers and lifecycle. Persistence and HTTP collection
// remain in the usecase and its output adapters.
type Scheduler struct {
	collector *usecase.CollectionUsecase
	source    HubSource
	mu        sync.Mutex
	jobs      map[string]context.CancelFunc
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
}

func New(collector *usecase.CollectionUsecase, source HubSource) (*Scheduler, error) {
	if collector == nil || source == nil {
		return nil, errors.New("scheduler dependencies are required")
	}
	return &Scheduler{collector: collector, source: source, jobs: make(map[string]context.CancelFunc)}, nil
}

// Restore starts one timer per enabled Hub. No missed intervals are replayed;
// the first scheduled request occurs after one full configured interval.
func (s *Scheduler) Restore(ctx context.Context) error {
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("scheduler is already running")
	}
	s.ctx, s.cancel = context.WithCancel(ctx)
	s.mu.Unlock()
	rows, err := s.source.ListHubRows(ctx)
	if err != nil {
		_ = s.Close()
		return err
	}
	for _, row := range rows {
		events, err := s.source.ListCredentialAuditEvents(ctx, row.Hub.ID)
		if err != nil {
			_ = s.Close()
			return err
		}
		credentialEvents := make([]domain.CredentialEvent, 0, len(events))
		for _, event := range events {
			credentialEvents = append(credentialEvents, domain.CredentialEvent{Sequence: event.Sequence, Action: event.Action})
		}
		if row.Hub.Enabled && row.Hub.CollectionEnabled && domain.DeriveCredentialState(credentialEvents) == domain.CredentialRegistered {
			if err := s.startJob(row.Hub.ID, row.Hub.CollectionIntervalSeconds); err != nil {
				_ = s.Close()
				return err
			}
		}
	}
	return nil
}

func (s *Scheduler) Suspend(context.Context) (bool, error) {
	s.mu.Lock()
	wasRunning := s.cancel != nil
	s.mu.Unlock()
	if !wasRunning {
		return false, nil
	}
	return true, s.Close()
}

func (s *Scheduler) Resume(ctx context.Context) error {
	return s.Restore(ctx)
}

func (s *Scheduler) Start(ctx context.Context, hubID string) error {
	if err := s.collector.StartCollection(ctx, hubID); err != nil {
		return err
	}
	row, err := s.source.GetHubRow(ctx, hubID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	running := s.cancel != nil
	s.mu.Unlock()
	if !running {
		return nil
	}
	return s.startJob(hubID, row.Hub.CollectionIntervalSeconds)
}

func (s *Scheduler) Stop(ctx context.Context, hubID string) error {
	if err := s.collector.StopCollection(ctx, hubID); err != nil {
		return err
	}
	s.mu.Lock()
	if cancel, ok := s.jobs[hubID]; ok {
		cancel()
		delete(s.jobs, hubID)
	}
	s.mu.Unlock()
	return nil
}

func (s *Scheduler) CollectNow(ctx context.Context, hubID string) error {
	return s.collector.CollectNow(ctx, hubID)
}

func (s *Scheduler) Close() error {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	for hubID, cancel := range s.jobs {
		cancel()
		delete(s.jobs, hubID)
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}

func (s *Scheduler) startJob(hubID string, intervalSeconds int64) error {
	if intervalSeconds <= 0 {
		return errors.New("collection interval must be positive")
	}
	s.mu.Lock()
	if _, exists := s.jobs[hubID]; exists {
		s.mu.Unlock()
		return nil
	}
	if s.ctx == nil {
		s.mu.Unlock()
		return nil
	}
	jobContext, cancel := context.WithCancel(s.ctx)
	s.jobs[hubID] = cancel
	s.wg.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(time.Duration(intervalSeconds) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = s.collector.CollectScheduled(jobContext, hubID)
			case <-jobContext.Done():
				return
			}
		}
	}()
	return nil
}
