package usecase

import (
	"context"
	"errors"
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
)

type collectionTestClock struct{ value time.Time }

func (c collectionTestClock) Now() time.Time { return c.value }

type collectionTestIDs struct {
	mu sync.Mutex
	n  int
}

func (g *collectionTestIDs) New() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.n++
	return uuid.NewString()
}

type collectionTestCredentials struct{}

func (collectionTestCredentials) Read(string) (string, bool, error) { return "secret", true, nil }

type countingCollectionCredentials struct {
	reads atomic.Int32
	found bool
}

func (c *countingCollectionCredentials) Read(string) (string, bool, error) {
	c.reads.Add(1)
	return "secret", c.found, nil
}

type blockingCollectionClient struct {
	entered chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (c *blockingCollectionClient) FetchStats(context.Context, string) (hubapi.Result, error) {
	c.calls.Add(1)
	select {
	case <-c.entered:
	default:
		close(c.entered)
	}
	<-c.release
	return hubapi.Result{}, errors.New("blocked client")
}

func TestCollectionStoresExactRawBodiesAndNormalizedObservations(t *testing.T) {
	ctx := context.Background()
	database := &sqliteadapter.Lifecycle{}
	if err := database.Open(ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/health":
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
		case "/api/stats":
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	if err := database.CreateHub(ctx, sqliteadapter.Hub{ID: hubID, DisplayName: "Hub", URL: server.URL, CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendCredentialAudit(ctx, sqliteadapter.CredentialAudit{AuditID: uuid.NewString(), OccurredAt: now, Action: "credential_saved", HubID: hubID}); err != nil {
		t.Fatal(err)
	}
	allowlist := hubapi.NewAllowlist(hubapi.Contract{Build: hubapi.BuildIdentity{SchemaVersion: 1, Runtime: "test-hub", CoreBuildID: "core", RuntimeBuildID: "runtime"}, UsageUpdatedAt: true})
	ids := &collectionTestIDs{}
	uc, err := NewCollectionUsecase(database, collectionTestCredentials{}, func(rawURL string, allow hubapi.Allowlist) (CollectionClient, error) {
		return hubapi.NewClient(rawURL, allow)
	}, collectionTestClock{value: now}, ids, allowlist)
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.CollectNow(ctx, hubID); err != nil {
		t.Fatal(err)
	}
	attempts, err := database.ListCollectionAttempts(ctx, hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].State != "succeeded" {
		t.Fatalf("attempts = %+v", attempts)
	}
	snapshot, err := database.GetRawSnapshot(ctx, attempts[0].StatsSnapshotID)
	if err != nil {
		t.Fatal(err)
	}
	wantStats := `{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
	if string(snapshot.Body) != wantStats {
		t.Fatalf("stats body changed: %q", snapshot.Body)
	}
	snapshots, err := database.ListRawSnapshots(ctx, hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("raw snapshot count = %d, want 2", len(snapshots))
	}
	for _, item := range snapshots {
		if item.ResponseKind == "health" && string(item.Body) != `{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime"}}` {
			t.Fatalf("health body changed: %q", item.Body)
		}
	}
	costs, err := database.ListCostObservations(ctx, hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(costs) != 1 || costs[0].CostUSDText != "1.0" || costs[0].SyncUploadIntervalMS == nil || *costs[0].SyncUploadIntervalMS != 0 || costs[0].SourceTimezone != "Asia/Tokyo" || costs[0].SourceLocalDate != "2026-08-25" {
		t.Fatalf("costs = %+v", costs)
	}
	var limitCount int
	if err := func() error {
		db, err := database.DB()
		if err != nil {
			return err
		}
		return db.QueryRow(`SELECT count(*) FROM usage_limit_observations WHERE hub_id = ?`, hubID).Scan(&limitCount)
	}(); err != nil {
		t.Fatal(err)
	}
	if limitCount != 1 {
		t.Fatalf("limit count = %d", limitCount)
	}
}

func TestCollectionKeepsRawWhenNormalizationFails(t *testing.T) {
	fixture := newCollectionFixture(t, true, `{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":[]}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].State != "failed" || attempts[0].FailureCode != "normalization_failed" {
		t.Fatalf("attempts = %+v", attempts)
	}
	snapshots, err := fixture.database.ListRawSnapshots(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("raw snapshots = %d, want health and stats", len(snapshots))
	}
	costs, err := fixture.database.ListCostObservations(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(costs) != 0 {
		t.Fatalf("normalized costs = %d, want 0", len(costs))
	}
}

func TestInvalidStatsRecordsFailureWithoutStatsRaw(t *testing.T) {
	fixture := newCollectionFixture(t, true, `{"devices":`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].State != "failed" || attempts[0].FailureCode != string(hubapi.ClassificationInvalidJSON) {
		t.Fatalf("attempts = %+v", attempts)
	}
	snapshots, err := fixture.database.ListRawSnapshots(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 1 || snapshots[0].ResponseKind != "health" {
		t.Fatalf("raw snapshots = %+v", snapshots)
	}
}

func TestDisabledHubSkipsWithoutCredentialOrHTTP(t *testing.T) {
	credentials := &countingCollectionCredentials{found: true}
	fixture := newCollectionFixture(t, false, `{"devices":[]}`, nil, credentials, nil)
	if err := fixture.database.SetHubEnabled(fixture.ctx, fixture.hubID, false, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	if fixture.statsCalls.Load() != 0 || credentials.reads.Load() != 0 {
		t.Fatalf("stats calls=%d credential reads=%d", fixture.statsCalls.Load(), credentials.reads.Load())
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].State != "skipped" || attempts[0].FailureCode != "hub_disabled" {
		t.Fatalf("attempts = %+v", attempts)
	}
}

func TestStoppedPeriodicCollectionAllowsManualButSkipsScheduled(t *testing.T) {
	fixture := newCollectionFixture(t, false, `{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	if fixture.statsCalls.Load() != 1 {
		t.Fatalf("manual stats calls = %d, want 1", fixture.statsCalls.Load())
	}
	if err := fixture.usecase.CollectScheduled(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	if fixture.statsCalls.Load() != 1 {
		t.Fatalf("scheduled collection ran while stopped: calls=%d", fixture.statsCalls.Load())
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	var succeeded, stopped int
	for _, attempt := range attempts {
		if attempt.State == "succeeded" {
			succeeded++
		}
		if attempt.FailureCode == "collection_disabled" {
			stopped++
		}
	}
	if len(attempts) != 2 || succeeded != 1 || stopped != 1 {
		t.Fatalf("attempts = %+v", attempts)
	}
}

func TestConcurrentCollectionSkipsSecondRequest(t *testing.T) {
	client := &blockingCollectionClient{entered: make(chan struct{}), release: make(chan struct{})}
	factory := func(string, hubapi.Allowlist) (CollectionClient, error) { return client, nil }
	fixture := newCollectionFixture(t, true, `{"devices":[]}`, []string{"credential_saved"}, collectionTestCredentials{}, factory)
	firstDone := make(chan error, 1)
	go func() { firstDone <- fixture.usecase.CollectScheduled(fixture.ctx, fixture.hubID) }()
	select {
	case <-client.entered:
	case <-time.After(time.Second):
		t.Fatal("first collection did not enter client")
	}
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	close(client.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if client.calls.Load() != 1 {
		t.Fatalf("client calls = %d, want 1", client.calls.Load())
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 2 {
		t.Fatalf("attempts = %d, want 2", len(attempts))
	}
}

func TestPostRestorePendingSkipsCredentialRead(t *testing.T) {
	credentials := &countingCollectionCredentials{found: true}
	fixture := newCollectionFixture(t, true, `{"devices":[]}`, []string{"restore_succeeded"}, credentials, nil)
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); err != nil {
		t.Fatal(err)
	}
	if credentials.reads.Load() != 0 || fixture.statsCalls.Load() != 0 {
		t.Fatalf("credential reads=%d stats calls=%d", credentials.reads.Load(), fixture.statsCalls.Load())
	}
	attempts, err := fixture.database.ListCollectionAttempts(fixture.ctx, fixture.hubID)
	if err != nil {
		t.Fatal(err)
	}
	if len(attempts) != 1 || attempts[0].FailureCode != string(hubapi.ClassificationAuth) {
		t.Fatalf("attempts = %+v", attempts)
	}
}

type collectionFixture struct {
	ctx        context.Context
	database   *sqliteadapter.Lifecycle
	hubID      string
	usecase    *CollectionUsecase
	server     *httptest.Server
	statsCalls atomic.Int32
}

func newCollectionFixture(t *testing.T, enabled bool, statsBody string, actions []string, credentials CredentialReader, factory CollectionClientFactory) *collectionFixture {
	t.Helper()
	ctx := context.Background()
	database := &sqliteadapter.Lifecycle{}
	if err := database.Open(ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	fixture := &collectionFixture{ctx: ctx, database: database, hubID: hubID}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
			return
		}
		if request.URL.Path == "/api/stats" {
			fixture.statsCalls.Add(1)
			_, _ = writer.Write([]byte(statsBody))
			return
		}
		http.NotFound(writer, request)
	}))
	t.Cleanup(fixture.server.Close)
	if err := database.CreateHub(ctx, sqliteadapter.Hub{ID: hubID, DisplayName: "Hub", URL: fixture.server.URL, CollectionEnabled: enabled, CollectionIntervalSeconds: 1, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for _, action := range actions {
		if err := database.AppendCredentialAudit(ctx, sqliteadapter.CredentialAudit{AuditID: uuid.NewString(), OccurredAt: now, Action: action, HubID: hubID}); err != nil {
			t.Fatal(err)
		}
	}
	if credentials == nil {
		credentials = collectionTestCredentials{}
	}
	if factory == nil {
		factory = func(rawURL string, allow hubapi.Allowlist) (CollectionClient, error) {
			return hubapi.NewClient(rawURL, allow)
		}
	}
	allowlist := hubapi.NewAllowlist(hubapi.Contract{Build: hubapi.BuildIdentity{SchemaVersion: 1, Runtime: "test-hub", CoreBuildID: "core", RuntimeBuildID: "runtime"}, UsageUpdatedAt: true})
	uc, err := NewCollectionUsecase(database, credentials, factory, collectionTestClock{value: now}, &collectionTestIDs{}, allowlist)
	if err != nil {
		t.Fatal(err)
	}
	fixture.usecase = uc
	return fixture
}
