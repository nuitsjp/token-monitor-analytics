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

type collectionHubAPIClient struct{ client *hubapi.Client }

func (c collectionHubAPIClient) FetchStats(ctx context.Context, secret string) (CollectionResult, error) {
	result, err := c.client.FetchStats(ctx, secret)
	return CollectionResult{
		Health: CollectionResponse{Raw: result.Health.Raw, HTTPStatus: result.Health.HTTPStatus},
		Stats:  CollectionResponse{Raw: result.Stats.Raw, HTTPStatus: result.Stats.HTTPStatus},
		Contract: CollectionContract{
			Build: CollectionBuildIdentity{
				SchemaVersion: result.Contract.Build.SchemaVersion, Runtime: result.Contract.Build.Runtime,
				CoreBuildID: result.Contract.Build.CoreBuildID, RuntimeBuildID: result.Contract.Build.RuntimeBuildID,
				CoreRevision: result.Contract.Build.CoreRevision, RuntimeRevision: result.Contract.Build.RuntimeRevision,
			},
			UsageUpdatedAt: result.Contract.UsageUpdatedAt,
		},
	}, err
}

func collectionHubAPIFactory(allowlist hubapi.Allowlist) CollectionClientFactory {
	return func(rawURL string) (CollectionClient, error) {
		client, err := hubapi.NewClient(rawURL, allowlist)
		if err != nil {
			return nil, err
		}
		return collectionHubAPIClient{client: client}, nil
	}
}

func collectionHubAPIDependencies() CollectionDependencies {
	return CollectionDependencies{
		NormalizeStats: func(raw []byte) (NormalizedStats, error) {
			result, err := hubapi.NormalizeStats(raw)
			if err != nil {
				return NormalizedStats{}, err
			}
			normalized := NormalizedStats{}
			for _, item := range result.Costs {
				normalized.Costs = append(normalized.Costs, NormalizedCostObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, CostUSDText: item.CostUSDText, SyncUploadIntervalMS: item.SyncUploadIntervalMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			for _, item := range result.Usage {
				normalized.Usage = append(normalized.Usage, NormalizedUsageObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, TokenCount: item.TokenCount, APICostUSDText: item.APICostUSDText, ModelTokens: item.ModelTokens, ModelCosts: item.ModelCosts, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			for _, item := range result.Limits {
				normalized.Limits = append(normalized.Limits, NormalizedLimitObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, AccountKey: item.AccountKey, AccountKeyKind: item.AccountKeyKind, AccountLabel: item.AccountLabel, AccountEmail: item.AccountEmail, ProviderUpdatedAt: item.ProviderUpdatedAt, WindowKey: item.WindowKey, NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric, NormalizedLabel: item.NormalizedLabel, PlanLabel: item.PlanLabel, UsedPercent: item.UsedPercent, AbsoluteUsedText: item.AbsoluteUsedText, AbsoluteLimitText: item.AbsoluteLimitText, AbsoluteRemainingText: item.AbsoluteRemainingText, Currency: item.Currency, ResetsAt: item.ResetsAt, SyncUploadIntervalMS: item.SyncUploadIntervalMS, LimitsRefreshMS: item.LimitsRefreshMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint, WindowKeyConflict: item.WindowKeyConflict})
			}
			return normalized, nil
		},
		ClassifyError: func(err error) string {
			if classification := CollectionClassificationOf(err); classification != "" {
				return classification
			}
			return string(hubapi.ClassificationOf(err))
		},
		NormalizationGeneration:   hubapi.NormalizationGeneration,
		NormalizationRuleVersion:  hubapi.NormalizationRuleVersion,
		NormalizationLogicVersion: hubapi.NormalizationLogicVersion,
	}
}

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

func TestBuildObservationBatchCarriesLimitIdentityMetadata(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	batch := buildObservationBatch(NormalizedStats{Limits: []NormalizedLimitObservation{{
		DeviceID: "device", RawServiceIdentifier: "grok", AccountKey: "subject-1", AccountKeyKind: "oidc-subject-v1", AccountLabel: "Grok Personal", AccountEmail: "person@example.test", ProviderUpdatedAt: now,
		JSONPath: "$.limit", DedupeKey: "dedupe", ValueFingerprint: "fingerprint",
	}}}, "snapshot", "hub", 300, &collectionTestIDs{}, CollectionDependencies{NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic"})
	if len(batch.limits) != 1 {
		t.Fatalf("limits = %+v", batch.limits)
	}
	limit := batch.limits[0]
	if limit.AccountKeyKind != "oidc-subject-v1" || limit.AccountDisplayName != "Grok Personal" || limit.AccountEmail != "person@example.test" {
		t.Fatalf("limit identity metadata = %+v", limit)
	}
}

func (c *blockingCollectionClient) FetchStats(context.Context, string) (CollectionResult, error) {
	c.calls.Add(1)
	select {
	case <-c.entered:
	default:
		close(c.entered)
	}
	<-c.release
	return CollectionResult{}, errors.New("blocked client")
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
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}`))
		case "/api/stats":
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`))
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
	allowlist := hubapi.NewAllowlist(hubapi.ContractPolicy{SchemaVersion: 1, Runtime: "test-hub", MinimumCoreRevision: 1, UsageUpdatedAt: true})
	ids := &collectionTestIDs{}
	uc, err := NewCollectionUsecase(database, collectionTestCredentials{}, collectionHubAPIFactory(allowlist), collectionTestClock{value: now}, ids, collectionHubAPIDependencies(), NewMaintenanceGate())
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
	wantStats := `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periodWindows":{"timeZone":"Asia/Tokyo","today":{"key":"2026-08-25"}},"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`
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
		if item.ResponseKind == "health" && string(item.Body) != `{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}` {
			t.Fatalf("health body changed: %q", item.Body)
		}
	}
	t.Run("P1-COL-04 successful collection records Hub UTC HTTP contract and raw snapshot lineage", func(t *testing.T) {
		attempt := attempts[0]
		if attempt.HubID != hubID || attempt.Trigger != "manual" || attempt.StartedAt.Location() != time.UTC || attempt.CompletedAt == nil || attempt.CompletedAt.Location() != time.UTC {
			t.Fatalf("attempt metadata = %+v", attempt)
		}
		if attempt.HealthHTTPStatus == nil || *attempt.HealthHTTPStatus != http.StatusOK || attempt.StatsHTTPStatus == nil || *attempt.StatsHTTPStatus != http.StatusOK {
			t.Fatalf("attempt HTTP statuses = health=%v stats=%v", attempt.HealthHTTPStatus, attempt.StatsHTTPStatus)
		}
		if attempt.APIContract == "" || attempt.HealthSnapshotID == "" || attempt.StatsSnapshotID != snapshot.SnapshotID {
			t.Fatalf("attempt contract/snapshots = %q/%q/%q", attempt.APIContract, attempt.HealthSnapshotID, attempt.StatsSnapshotID)
		}
		if snapshot.AttemptID != attempt.AttemptID || snapshot.HubID != hubID || snapshot.ResponseKind != "stats" || snapshot.HTTPStatus != http.StatusOK || snapshot.APIContract != attempt.APIContract || snapshot.ReceivedStartedAt.Location() != time.UTC || snapshot.ReceivedCompletedAt.Location() != time.UTC || string(snapshot.Body) != wantStats {
			t.Fatalf("stats snapshot metadata = %+v", snapshot)
		}
	})
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
	limits, err := database.ListLimitObservations(ctx, hubID)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("normalized observations retain raw snapshot and JSON paths", func(t *testing.T) {
		if len(costs) != 1 || costs[0].SnapshotID != snapshot.SnapshotID || costs[0].JSONPath != `$.devices[0].periods.allTime.clientCosts["codex"]` {
			t.Fatalf("cost lineage = %+v", costs)
		}
		if len(limits) != 1 || limits[0].SnapshotID != snapshot.SnapshotID || limits[0].JSONPath == "" {
			t.Fatalf("limit lineage = %+v", limits)
		}
		if len(snapshots) != 2 || string(snapshot.Body) != wantStats {
			t.Fatalf("raw snapshots were not retained: count=%d body=%q", len(snapshots), snapshot.Body)
		}
	})
}

func TestCollectionKeepsRawWhenNormalizationFails(t *testing.T) {
	fixture := newCollectionFixture(t, true, `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":[]}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
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

func TestCollectionLineageAndRawRetentionAcrossNormalizationOutcome(t *testing.T) {
	t.Run("P1-COL-05 observations trace to raw JSON and normalization failure preserves it", func(t *testing.T) {
		success := newCollectionFixture(t, true, `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":{"allTime":{"clientCosts":{"codex":1.0}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","planLabel":"Plus","updatedAt":"2026-08-25T11:35:00Z","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":42,"resetsAt":"2026-09-01T00:00:00Z"}]}]}}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
		if err := success.usecase.CollectNow(success.ctx, success.hubID); err != nil {
			t.Fatal(err)
		}
		successAttempts, err := success.database.ListCollectionAttempts(success.ctx, success.hubID)
		if err != nil {
			t.Fatal(err)
		}
		successSnapshots, err := success.database.ListRawSnapshots(success.ctx, success.hubID)
		if err != nil {
			t.Fatal(err)
		}
		costs, err := success.database.ListCostObservations(success.ctx, success.hubID)
		if err != nil {
			t.Fatal(err)
		}
		limits, err := success.database.ListLimitObservations(success.ctx, success.hubID)
		if err != nil {
			t.Fatal(err)
		}
		if len(successAttempts) != 1 || successAttempts[0].State != "succeeded" || len(successSnapshots) != 2 || len(costs) != 1 || len(limits) != 1 {
			t.Fatalf("successful collection lineage = attempts=%+v snapshots=%d costs=%d limits=%d", successAttempts, len(successSnapshots), len(costs), len(limits))
		}
		statsSnapshotID := successAttempts[0].StatsSnapshotID
		if statsSnapshotID == "" || costs[0].SnapshotID != statsSnapshotID || costs[0].JSONPath == "" || limits[0].SnapshotID != statsSnapshotID || limits[0].JSONPath == "" {
			t.Fatalf("observation lineage = cost=%+v limit=%+v attempt=%+v", costs[0], limits[0], successAttempts[0])
		}

		failure := newCollectionFixture(t, true, `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0,"periods":[]}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
		if err := failure.usecase.CollectNow(failure.ctx, failure.hubID); err != nil {
			t.Fatal(err)
		}
		failureAttempts, err := failure.database.ListCollectionAttempts(failure.ctx, failure.hubID)
		if err != nil {
			t.Fatal(err)
		}
		failureSnapshots, err := failure.database.ListRawSnapshots(failure.ctx, failure.hubID)
		if err != nil {
			t.Fatal(err)
		}
		failureCosts, err := failure.database.ListCostObservations(failure.ctx, failure.hubID)
		if err != nil {
			t.Fatal(err)
		}
		if len(failureAttempts) != 1 || failureAttempts[0].FailureCode != "normalization_failed" || len(failureSnapshots) != 2 || len(failureCosts) != 0 {
			t.Fatalf("failed normalization retention = attempts=%+v snapshots=%d costs=%d", failureAttempts, len(failureSnapshots), len(failureCosts))
		}
	})
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
	fixture := newCollectionFixture(t, false, `{"devices":[{"deviceId":"device-1","updatedAt":"2026-08-25T11:36:00Z","syncUploadIntervalMs":0}]}`, []string{"credential_saved"}, collectionTestCredentials{}, nil)
	t.Run("P1-COL-01 positive interval supports manual run and stopped schedule", func(t *testing.T) {
		row, err := fixture.database.GetHubRow(fixture.ctx, fixture.hubID)
		if err != nil {
			t.Fatal(err)
		}
		if row.Hub.CollectionIntervalSeconds <= 0 || row.Hub.CollectionEnabled {
			t.Fatalf("initial collection settings = %+v", row.Hub)
		}
		if err := fixture.usecase.StartCollection(fixture.ctx, fixture.hubID); err != nil {
			t.Fatal(err)
		}
		if err := fixture.usecase.StopCollection(fixture.ctx, fixture.hubID); err != nil {
			t.Fatal(err)
		}
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
	})
}

func TestConcurrentCollectionSkipsSecondRequest(t *testing.T) {
	client := &blockingCollectionClient{entered: make(chan struct{}), release: make(chan struct{})}
	factory := func(string) (CollectionClient, error) { return client, nil }
	fixture := newCollectionFixture(t, true, `{"devices":[]}`, []string{"credential_saved"}, collectionTestCredentials{}, factory)
	firstDone := make(chan error, 1)
	go func() { firstDone <- fixture.usecase.CollectScheduled(fixture.ctx, fixture.hubID) }()
	select {
	case <-client.entered:
	case <-time.After(time.Second):
		t.Fatal("first collection did not enter client")
	}
	if err := fixture.usecase.CollectNow(fixture.ctx, fixture.hubID); !errors.Is(err, ErrMaintenanceBusy) {
		t.Fatalf("second collection error = %v, want maintenance busy", err)
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
	if len(attempts) != 1 {
		t.Fatalf("attempts = %d, want 1", len(attempts))
	}
}

func TestPostRestorePendingSkipsCredentialRead(t *testing.T) {
	t.Run("P1-RESTORE-06 post-restore credential is required before collection", func(t *testing.T) {
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
	})
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
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test-hub","coreBuildId":"core","runtimeBuildId":"runtime","coreRevision":1}}`))
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
		factory = collectionHubAPIFactory(hubapi.NewAllowlist(hubapi.ContractPolicy{SchemaVersion: 1, Runtime: "test-hub", MinimumCoreRevision: 1, UsageUpdatedAt: true}))
	}
	uc, err := NewCollectionUsecase(database, credentials, factory, collectionTestClock{value: now}, &collectionTestIDs{}, collectionHubAPIDependencies(), NewMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	fixture.usecase = uc
	return fixture
}
