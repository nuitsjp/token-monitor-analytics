package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/adapter/hubapi"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/usecase"
)

type schedulerClock struct{}

func (schedulerClock) Now() time.Time { return time.Now().UTC() }

type schedulerTestTicker struct {
	ch       chan time.Time
	stopped  chan struct{}
	stopOnce sync.Once
}

func (t *schedulerTestTicker) C() <-chan time.Time { return t.ch }

func (t *schedulerTestTicker) Stop() {
	t.stopOnce.Do(func() { close(t.stopped) })
}

func (t *schedulerTestTicker) tick() {
	select {
	case t.ch <- time.Now():
	default:
	}
}

type schedulerTickerFactory struct {
	mu      sync.Mutex
	tickers []*schedulerTestTicker
	created chan struct{}
	once    sync.Once
}

type blockingSchedulerSource struct {
	HubSource
	entered chan struct{}
	once    sync.Once
}

func (s *blockingSchedulerSource) ListHubRows(ctx context.Context) ([]sqliteadapter.HubRow, error) {
	s.once.Do(func() { close(s.entered) })
	<-ctx.Done()
	return nil, ctx.Err()
}

func newSchedulerTickerFactory() *schedulerTickerFactory {
	return &schedulerTickerFactory{created: make(chan struct{})}
}

func (f *schedulerTickerFactory) New(time.Duration) schedulerTicker {
	ticker := &schedulerTestTicker{ch: make(chan time.Time, 1), stopped: make(chan struct{})}
	f.mu.Lock()
	f.tickers = append(f.tickers, ticker)
	f.mu.Unlock()
	f.once.Do(func() { close(f.created) })
	return ticker
}

func (f *schedulerTickerFactory) WaitForTicker(t *testing.T) {
	t.Helper()
	select {
	case <-f.created:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not create a ticker")
	}
}

func (f *schedulerTickerFactory) Tick() {
	f.mu.Lock()
	tickers := append([]*schedulerTestTicker(nil), f.tickers...)
	f.mu.Unlock()
	for _, ticker := range tickers {
		ticker.tick()
	}
}

func (f *schedulerTickerFactory) AssertAllStopped(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	tickers := append([]*schedulerTestTicker(nil), f.tickers...)
	f.mu.Unlock()
	for _, ticker := range tickers {
		// The stopped channel is closed by Stop, so a receive is a deterministic
		// indication that the timer was released.
		select {
		case <-ticker.stopped:
		default:
			t.Error("scheduler ticker was not stopped")
		}
	}
}

func waitForSchedulerAttempt(t *testing.T, ctx context.Context, database *sqliteadapter.Lifecycle, hubID string) {
	t.Helper()
	deadline := time.NewTimer(4 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(time.Millisecond)
	defer poll.Stop()
	for {
		attempts, err := database.ListCollectionAttempts(ctx, hubID)
		if err != nil {
			t.Fatal(err)
		}
		if len(attempts) > 0 && attempts[0].State != "started" {
			return
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			t.Fatal("scheduler collection did not finish")
		}
	}
}

type schedulerIDs struct{}

func (schedulerIDs) New() string { return uuid.NewString() }

type schedulerCredentials struct{}

func (schedulerCredentials) Read(string) (string, bool, error) { return "secret", true, nil }

type schedulerHubAPIClient struct{ client *hubapi.Client }

func (c schedulerHubAPIClient) FetchStats(ctx context.Context, secret string) (usecase.CollectionResult, error) {
	result, err := c.client.FetchStats(ctx, secret)
	return usecase.CollectionResult{
		Health: usecase.CollectionResponse{Raw: result.Health.Raw, HTTPStatus: result.Health.HTTPStatus},
		Stats:  usecase.CollectionResponse{Raw: result.Stats.Raw, HTTPStatus: result.Stats.HTTPStatus},
		Contract: usecase.CollectionContract{
			Build: usecase.CollectionBuildIdentity{
				SchemaVersion: result.Contract.Build.SchemaVersion, Runtime: result.Contract.Build.Runtime,
				CoreBuildID: result.Contract.Build.CoreBuildID, RuntimeBuildID: result.Contract.Build.RuntimeBuildID,
				CoreRevision: result.Contract.Build.CoreRevision, RuntimeRevision: result.Contract.Build.RuntimeRevision,
			},
			UsageUpdatedAt: result.Contract.UsageUpdatedAt,
		},
	}, err
}

func schedulerHubAPIFactory(allowlist hubapi.Allowlist) usecase.CollectionClientFactory {
	return func(rawURL string) (usecase.CollectionClient, error) {
		client, err := hubapi.NewClient(rawURL, allowlist)
		if err != nil {
			return nil, err
		}
		return schedulerHubAPIClient{client: client}, nil
	}
}

func schedulerCollectionDependencies() usecase.CollectionDependencies {
	return usecase.CollectionDependencies{
		NormalizeStats: func(raw []byte) (usecase.NormalizedStats, error) {
			_, err := hubapi.NormalizeStats(raw)
			return usecase.NormalizedStats{}, err
		},
		ClassifyError: func(err error) string {
			if classification := usecase.CollectionClassificationOf(err); classification != "" {
				return classification
			}
			return string(hubapi.ClassificationOf(err))
		},
		NormalizationGeneration:   hubapi.NormalizationGeneration,
		NormalizationRuleVersion:  hubapi.NormalizationRuleVersion,
		NormalizationLogicVersion: hubapi.NormalizationLogicVersion,
	}
}

func TestSchedulerRestoresEnabledHubAndStopsTimers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database := &sqliteadapter.Lifecycle{}
	if err := database.Open(ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close scheduler database: %v", err)
		}
	})
	now := time.Now().UTC()
	hubID := uuid.NewString()
	var statsCalls atomic.Int32
	statsCollected := make(chan struct{}, 8)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"scheduler-test","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}`))
			return
		}
		if request.URL.Path == "/api/stats" {
			statsCalls.Add(1)
			statsCollected <- struct{}{}
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0}]}`))
			return
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	if err := database.CreateHub(ctx, sqliteadapter.Hub{ID: hubID, DisplayName: "Hub", URL: server.URL, CollectionEnabled: true, CollectionIntervalSeconds: 1, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendCredentialAudit(ctx, sqliteadapter.CredentialAudit{AuditID: uuid.NewString(), OccurredAt: now, Action: "credential_saved", HubID: hubID}); err != nil {
		t.Fatal(err)
	}
	allowlist := hubapi.NewAllowlist(hubapi.ContractPolicy{SchemaVersion: 1, Runtime: "scheduler-test", MinimumCoreRevision: 1, UsageUpdatedAt: true})
	collector, err := usecase.NewCollectionUsecase(database, schedulerCredentials{}, schedulerHubAPIFactory(allowlist), schedulerClock{}, schedulerIDs{}, schedulerCollectionDependencies(), usecase.NewMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := New(collector, database)
	if err != nil {
		t.Fatal(err)
	}
	tickerFactory := newSchedulerTickerFactory()
	scheduler.newTicker = tickerFactory.New
	if err := scheduler.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	t.Run("P1-COL-06 restart restores state and waits for the next interval", func(t *testing.T) {
		// Restore must not replay an elapsed interval immediately.
		tickerFactory.WaitForTicker(t)
		if statsCalls.Load() != 0 {
			t.Fatalf("stats calls before the first interval = %d, want 0", statsCalls.Load())
		}
		tickerFactory.Tick()
		select {
		case <-statsCollected:
		case <-time.After(4 * time.Second):
			t.Fatal("restored scheduler did not collect")
		}
		waitForSchedulerAttempt(t, ctx, database, hubID)
		if err := scheduler.Stop(ctx, hubID); err != nil {
			t.Fatal(err)
		}
		stoppedCalls := statsCalls.Load()
		if err := scheduler.Close(); err != nil {
			t.Fatal(err)
		}
		tickerFactory.Tick()
		if statsCalls.Load() != stoppedCalls {
			t.Fatalf("stats calls after stop = %d, want %d", statsCalls.Load(), stoppedCalls)
		}
		if err := database.SetHubCollectionEnabled(ctx, hubID, true, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		restarted, err := New(collector, database)
		if err != nil {
			t.Fatal(err)
		}
		restartedTickerFactory := newSchedulerTickerFactory()
		restarted.newTicker = restartedTickerFactory.New
		if err := restarted.Restore(ctx); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := restarted.Close(); err != nil {
				t.Errorf("close restarted scheduler: %v", err)
			}
		})
		restartedTickerFactory.WaitForTicker(t)
		if statsCalls.Load() != stoppedCalls {
			t.Fatalf("stats calls immediately after restart = %d, want %d", statsCalls.Load(), stoppedCalls)
		}
		restartedTickerFactory.Tick()
		select {
		case <-statsCollected:
		case <-time.After(4 * time.Second):
			t.Fatal("scheduler did not restore after restart")
		}
	})
}

func TestSchedulerDoesNotRestoreTimerAcrossGlobalRestoreCredentialBoundary(t *testing.T) {
	ctx := context.Background()
	database := &sqliteadapter.Lifecycle{}
	if err := database.Open(ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close scheduler database: %v", err)
		}
	})
	now := time.Now().UTC()
	hubID := uuid.NewString()
	if err := database.CreateHub(ctx, sqliteadapter.Hub{ID: hubID, DisplayName: "Hub", URL: "http://localhost:17321", CollectionEnabled: true, CollectionIntervalSeconds: 60, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendCredentialAudit(ctx, sqliteadapter.CredentialAudit{AuditID: uuid.NewString(), OccurredAt: now, Action: "credential_saved", HubID: hubID}); err != nil {
		t.Fatal(err)
	}
	raw, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, `INSERT INTO configuration_audits
		(audit_id, occurred_at, actor, action, entity_type, entity_id)
		VALUES (?, ?, 'system', 'restore_succeeded', 'restore', 'operation-one')`, uuid.NewString(), now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	gate := usecase.NewMaintenanceGate()
	collector, err := usecase.NewCollectionUsecase(database, schedulerCredentials{}, schedulerHubAPIFactory(hubapi.DefaultAllowlist), schedulerClock{}, schedulerIDs{}, schedulerCollectionDependencies(), gate)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := New(collector, database)
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := scheduler.Close(); err != nil {
			t.Errorf("close scheduler: %v", err)
		}
	})
	scheduler.mu.Lock()
	jobs := len(scheduler.jobs)
	scheduler.mu.Unlock()
	if jobs != 0 {
		t.Fatalf("post-restore scheduler jobs = %d, want 0", jobs)
	}
}

type schedulerFixture struct {
	ctx       context.Context
	database  *sqliteadapter.Lifecycle
	server    *httptest.Server
	scheduler *Scheduler
	hubID     string
	stats     atomic.Int32
}

func newSchedulerFixture(t *testing.T, status int, collectionEnabled bool) *schedulerFixture {
	t.Helper()
	fixture := &schedulerFixture{ctx: context.Background(), database: &sqliteadapter.Lifecycle{}, hubID: uuid.NewString()}
	if err := fixture.database.Open(fixture.ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := fixture.database.Close(); err != nil {
			t.Errorf("close scheduler database: %v", err)
		}
	})
	fixture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/health":
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"scheduler-test","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}`))
		case "/api/stats":
			fixture.stats.Add(1)
			if status != http.StatusOK {
				writer.WriteHeader(status)
				_, _ = writer.Write([]byte(`{"error":"test failure"}`))
				return
			}
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T00:00:00Z","syncUploadIntervalMs":0}]}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(fixture.server.Close)
	now := time.Now().UTC()
	if err := fixture.database.CreateHub(fixture.ctx, sqliteadapter.Hub{
		ID: fixture.hubID, DisplayName: "Hub", URL: fixture.server.URL, Enabled: true,
		CollectionEnabled: collectionEnabled, CollectionIntervalSeconds: 60, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.database.AppendCredentialAudit(fixture.ctx, sqliteadapter.CredentialAudit{
		AuditID: uuid.NewString(), OccurredAt: now, Action: "credential_saved", HubID: fixture.hubID,
	}); err != nil {
		t.Fatal(err)
	}
	allowlist := hubapi.NewAllowlist(hubapi.ContractPolicy{SchemaVersion: 1, Runtime: "scheduler-test", MinimumCoreRevision: 1, UsageUpdatedAt: true})
	collector, err := usecase.NewCollectionUsecase(fixture.database, schedulerCredentials{}, schedulerHubAPIFactory(allowlist), schedulerClock{}, schedulerIDs{}, schedulerCollectionDependencies(), usecase.NewMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	fixture.scheduler, err = New(collector, fixture.database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := fixture.scheduler.Close(); err != nil {
			t.Errorf("close scheduler: %v", err)
		}
	})
	return fixture
}

func (f *schedulerFixture) jobCount() int {
	f.scheduler.mu.Lock()
	defer f.scheduler.mu.Unlock()
	return len(f.scheduler.jobs)
}

func TestSchedulerPublicLifecycleOperations(t *testing.T) {
	fixture := newSchedulerFixture(t, http.StatusOK, false)

	wasRunning, err := fixture.scheduler.Suspend(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if wasRunning {
		t.Fatal("suspending an idle scheduler reported it was running")
	}

	if err := fixture.scheduler.Start(fixture.ctx, fixture.hubID); err != nil {
		t.Fatalf("start while scheduler is stopped: %v", err)
	}
	row, err := fixture.database.GetHubRow(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if !row.Hub.CollectionEnabled {
		t.Fatal("Start did not enable collection")
	}
	if jobs := fixture.jobCount(); jobs != 0 {
		t.Fatalf("jobs before Restore = %d, want 0", jobs)
	}

	if err := fixture.scheduler.Restore(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if jobs := fixture.jobCount(); jobs != 1 {
		t.Fatalf("jobs after Restore = %d, want 1", jobs)
	}
	if err := fixture.scheduler.Start(fixture.ctx, fixture.hubID); err != nil {
		t.Fatalf("duplicate Start: %v", err)
	}
	if jobs := fixture.jobCount(); jobs != 1 {
		t.Fatalf("jobs after duplicate Start = %d, want 1", jobs)
	}

	if err := fixture.scheduler.Stop(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	row, err = fixture.database.GetHubRow(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Hub.CollectionEnabled {
		t.Fatal("Stop did not disable collection")
	}
	if jobs := fixture.jobCount(); jobs != 0 {
		t.Fatalf("jobs after Stop = %d, want 0", jobs)
	}

	wasRunning, err = fixture.scheduler.Suspend(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !wasRunning {
		t.Fatal("Suspend did not report the running scheduler")
	}
	wasRunning, err = fixture.scheduler.Suspend(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if wasRunning {
		t.Fatal("second Suspend reported a running scheduler")
	}

	if err := fixture.scheduler.Resume(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if jobs := fixture.jobCount(); jobs != 0 {
		t.Fatalf("jobs after Resume with collection disabled = %d, want 0", jobs)
	}
	if err := fixture.scheduler.Start(fixture.ctx, fixture.hubID); err != nil {
		t.Fatalf("start after Resume: %v", err)
	}
	if jobs := fixture.jobCount(); jobs != 1 {
		t.Fatalf("jobs after start following Resume = %d, want 1", jobs)
	}
	if err := fixture.scheduler.Stop(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
}

func TestSchedulerConcurrentLifecycleOperationsCloseLeavesNoJobs(t *testing.T) {
	fixture := newSchedulerFixture(t, http.StatusOK, true)
	tickers := newSchedulerTickerFactory()
	fixture.scheduler.newTicker = tickers.New
	blockingSource := &blockingSchedulerSource{HubSource: fixture.database, entered: make(chan struct{})}
	fixture.scheduler.source = blockingSource

	resumeDone := make(chan error, 1)
	go func() { resumeDone <- fixture.scheduler.Resume(fixture.ctx) }()
	select {
	case <-blockingSource.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("Resume did not reach the source")
	}

	start := make(chan struct{})
	ready := make(chan struct{}, 4)
	results := make(chan string, 4)
	var operations sync.WaitGroup
	launch := func(name string, operation func() error) {
		operations.Add(1)
		go func() {
			defer operations.Done()
			ready <- struct{}{}
			<-start
			if err := operation(); err != nil {
				results <- name + ": " + err.Error()
			}
		}()
	}
	launch("Start", func() error { return fixture.scheduler.Start(fixture.ctx, fixture.hubID) })
	launch("Close", fixture.scheduler.Close)
	launch("CollectNow", func() error { return fixture.scheduler.CollectNow(fixture.ctx, fixture.hubID) })
	launch("Suspend", func() error {
		_, err := fixture.scheduler.Suspend(fixture.ctx)
		return err
	})
	for range 4 {
		<-ready
	}
	close(start)
	operations.Wait()
	select {
	case <-resumeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Resume did not finish after lifecycle shutdown")
	}
	close(results)
	for result := range results {
		t.Log(result)
	}

	if err := fixture.scheduler.Close(); err != nil {
		t.Fatal(err)
	}
	if jobs := fixture.jobCount(); jobs != 0 {
		t.Fatalf("jobs after concurrent lifecycle operations = %d, want 0", jobs)
	}
	tickers.AssertAllStopped(t)
}

func TestSchedulerCollectNowRecordsSucceededAttempt(t *testing.T) {
	fixture := newSchedulerFixture(t, http.StatusOK, false)
	if err := fixture.scheduler.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	if fixture.stats.Load() != 1 {
		t.Fatalf("stats calls = %d, want 1", fixture.stats.Load())
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 {
		t.Fatalf("collection attempts = %d, want 1", len(attempts))
	}
	attempt := attempts[0]
	if attempt.Trigger != "manual" || attempt.State != "succeeded" {
		t.Fatalf("attempt = trigger %q state %q, want manual/succeeded", attempt.Trigger, attempt.State)
	}
	if attempt.HealthHTTPStatus == nil || *attempt.HealthHTTPStatus != http.StatusOK || attempt.StatsHTTPStatus == nil || *attempt.StatsHTTPStatus != http.StatusOK {
		t.Fatalf("attempt HTTP statuses = health %v stats %v, want 200/200", attempt.HealthHTTPStatus, attempt.StatsHTTPStatus)
	}
}

func TestSchedulerCollectNowRecordsHTTPFailure(t *testing.T) {
	fixture := newSchedulerFixture(t, http.StatusServiceUnavailable, false)
	if err := fixture.scheduler.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatalf("CollectNow returned an operational error: %v", err)
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 {
		t.Fatalf("collection attempts = %d, want 1", len(attempts))
	}
	attempt := attempts[0]
	if attempt.State != "failed" || attempt.FailureCode != string(hubapi.ClassificationHTTP) {
		t.Fatalf("attempt = state %q failure code %q, want failed/http", attempt.State, attempt.FailureCode)
	}
}
