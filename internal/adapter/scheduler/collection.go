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
	runID     uint64
	wg        sync.WaitGroup
	newTicker func(time.Duration) schedulerTicker
}

type schedulerTicker interface {
	C() <-chan time.Time
	Stop()
}

type realSchedulerTicker struct{ ticker *time.Ticker }

func (t realSchedulerTicker) C() <-chan time.Time { return t.ticker.C }
func (t realSchedulerTicker) Stop()               { t.ticker.Stop() }

func New(collector *usecase.CollectionUsecase, source HubSource) (*Scheduler, error) {
	if collector == nil || source == nil {
		return nil, errors.New("scheduler dependencies are required")
	}
	return &Scheduler{
		collector: collector,
		source:    source,
		jobs:      make(map[string]context.CancelFunc),
		newTicker: func(interval time.Duration) schedulerTicker {
			return realSchedulerTicker{ticker: time.NewTicker(interval)}
		},
	}, nil
}

// Restore starts one timer per enabled Hub. No missed intervals are replayed;
// the first scheduled request occurs after one full configured interval.
func (s *Scheduler) Restore(ctx context.Context) error {
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return errors.New("scheduler is already running")
	}
	s.runID++
	runID := s.runID
	runCtx, cancel := context.WithCancel(ctx)
	s.ctx, s.cancel = runCtx, cancel
	s.mu.Unlock()
	rows, err := s.source.ListHubRows(runCtx)
	if err != nil {
		return s.restoreFailed(runID, runCtx, err)
	}
	for _, row := range rows {
		events, err := s.source.ListCredentialAuditEvents(runCtx, row.Hub.ID)
		if err != nil {
			return s.restoreFailed(runID, runCtx, err)
		}
		credentialEvents := make([]domain.CredentialEvent, 0, len(events))
		for _, event := range events {
			credentialEvents = append(credentialEvents, domain.CredentialEvent(event))
		}
		if row.Hub.Enabled && row.Hub.CollectionEnabled && domain.DeriveCredentialState(credentialEvents) == domain.CredentialRegistered {
			if err := s.startJob(runID, runCtx, row.Hub.ID, row.Hub.CollectionIntervalSeconds); err != nil {
				return s.restoreFailed(runID, runCtx, err)
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isRunningLocked(runID) {
		return nil
	}
	return runCtx.Err()
}

func (s *Scheduler) Suspend(context.Context) (bool, error) {
	s.mu.Lock()
	wasRunning := s.cancel != nil
	s.stopLocked()
	s.wg.Wait()
	s.mu.Unlock()
	return wasRunning, nil
}

func (s *Scheduler) Resume(ctx context.Context) error {
	return s.Restore(ctx)
}

func (s *Scheduler) Start(ctx context.Context, hubID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.collector.StartCollection(ctx, hubID); err != nil {
		return err
	}
	row, err := s.source.GetHubRow(ctx, hubID)
	if err != nil {
		return err
	}
	if s.cancel == nil {
		return nil
	}
	// A scheduled job must inherit the scheduler lifecycle rather than the
	// request-scoped context used to enable collection.
	return s.startJobLocked(s.runID, s.ctx, hubID, row.Hub.CollectionIntervalSeconds) //nolint:contextcheck
}

func (s *Scheduler) Stop(ctx context.Context, hubID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.collector.StopCollection(ctx, hubID); err != nil {
		return err
	}
	if cancel, ok := s.jobs[hubID]; ok {
		cancel()
		delete(s.jobs, hubID)
	}
	return nil
}

func (s *Scheduler) CollectNow(ctx context.Context, hubID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.collector.CollectNow(ctx, hubID)
}

func (s *Scheduler) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
	s.wg.Wait()
	return nil
}

func (s *Scheduler) startJob(runID uint64, ctx context.Context, hubID string, intervalSeconds int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startJobLocked(runID, ctx, hubID, intervalSeconds)
}

func (s *Scheduler) startJobLocked(runID uint64, ctx context.Context, hubID string, intervalSeconds int64) error {
	if !s.isRunningLocked(runID) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if intervalSeconds <= 0 {
		return errors.New("collection interval must be positive")
	}
	if _, exists := s.jobs[hubID]; exists {
		return nil
	}
	jobContext, cancel := context.WithCancel(ctx)
	s.jobs[hubID] = cancel
	s.wg.Add(1)
	ticker := s.newTicker(time.Duration(intervalSeconds) * time.Second)
	go func() {
		defer s.wg.Done()
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C():
				if jobContext.Err() != nil {
					return
				}
				_ = s.collector.CollectScheduled(jobContext, hubID)
			case <-jobContext.Done():
				return
			}
		}
	}()
	return nil
}

func (s *Scheduler) isRunningLocked(runID uint64) bool {
	return s.cancel != nil && s.ctx != nil && s.runID == runID
}

func (s *Scheduler) stopLocked() {
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.ctx = nil
	for hubID, cancel := range s.jobs {
		cancel()
		delete(s.jobs, hubID)
	}
}

func (s *Scheduler) restoreFailed(runID uint64, runCtx context.Context, err error) error {
	s.mu.Lock()
	if s.isRunningLocked(runID) {
		s.stopLocked()
		s.wg.Wait()
	}
	s.mu.Unlock()
	return err
}
