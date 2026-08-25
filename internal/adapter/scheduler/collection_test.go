package scheduler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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

type schedulerIDs struct{}

func (schedulerIDs) New() string { return uuid.NewString() }

type schedulerCredentials struct{}

func (schedulerCredentials) Read(string) (string, bool, error) { return "secret", true, nil }

func TestSchedulerRestoresEnabledHubAndStopsTimers(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	database := &sqliteadapter.Lifecycle{}
	if err := database.Open(ctx, filepath.Join(t.TempDir(), "analytics.sqlite3")); err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	now := time.Now().UTC()
	hubID := uuid.NewString()
	var statsCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"scheduler-test","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
			return
		}
		if request.URL.Path == "/api/stats" {
			statsCalls.Add(1)
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
	allowlist := hubapi.NewAllowlist(hubapi.Contract{Build: hubapi.BuildIdentity{SchemaVersion: 1, Runtime: "scheduler-test", CoreBuildID: "core", RuntimeBuildID: "runtime"}, UsageUpdatedAt: true})
	collector, err := usecase.NewCollectionUsecase(database, schedulerCredentials{}, func(rawURL string, allow hubapi.Allowlist) (usecase.CollectionClient, error) {
		return hubapi.NewClient(rawURL, allow)
	}, schedulerClock{}, schedulerIDs{}, allowlist, usecase.NewMaintenanceGate())
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
	t.Run("P1-COL-06 restart restores state and waits for the next interval", func(t *testing.T) {
		// Restore must not replay an elapsed interval immediately.
		time.Sleep(200 * time.Millisecond)
		if statsCalls.Load() != 0 {
			t.Fatalf("stats calls before the first interval = %d, want 0", statsCalls.Load())
		}
		deadline := time.Now().Add(4 * time.Second)
		for statsCalls.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if statsCalls.Load() == 0 {
			t.Fatal("restored scheduler did not collect")
		}
		if err := scheduler.Stop(ctx, hubID); err != nil {
			t.Fatal(err)
		}
		stoppedCalls := statsCalls.Load()
		time.Sleep(1200 * time.Millisecond)
		if statsCalls.Load() != stoppedCalls {
			t.Fatalf("stats calls after stop = %d, want %d", statsCalls.Load(), stoppedCalls)
		}
		if err := scheduler.Close(); err != nil {
			t.Fatal(err)
		}
		if err := database.SetHubCollectionEnabled(ctx, hubID, true, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		restarted, err := New(collector, database)
		if err != nil {
			t.Fatal(err)
		}
		if err := restarted.Restore(ctx); err != nil {
			t.Fatal(err)
		}
		defer restarted.Close()
		time.Sleep(200 * time.Millisecond)
		if statsCalls.Load() != stoppedCalls {
			t.Fatalf("stats calls immediately after restart = %d, want %d", statsCalls.Load(), stoppedCalls)
		}
		deadline = time.Now().Add(4 * time.Second)
		for statsCalls.Load() <= stoppedCalls && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if statsCalls.Load() <= stoppedCalls {
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
	defer database.Close()
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
	collector, err := usecase.NewCollectionUsecase(database, schedulerCredentials{}, func(rawURL string, allow hubapi.Allowlist) (usecase.CollectionClient, error) {
		return hubapi.NewClient(rawURL, allow)
	}, schedulerClock{}, schedulerIDs{}, hubapi.DefaultAllowlist, gate)
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
	defer scheduler.Close()
	scheduler.mu.Lock()
	jobs := len(scheduler.jobs)
	scheduler.mu.Unlock()
	if jobs != 0 {
		t.Fatalf("post-restore scheduler jobs = %d, want 0", jobs)
	}
}
