package desktop

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/adapter/hubapi"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/usecase"
)

type memoryCredentials struct {
	values    map[string]string
	writeErr  error
	deleteErr error
}

func (m *memoryCredentials) Write(hubID, secret string) error {
	if m.writeErr != nil {
		return m.writeErr
	}
	m.values[hubID] = secret
	return nil
}

func (m *memoryCredentials) Read(hubID string) (string, bool, error) {
	value, ok := m.values[hubID]
	return value, ok, nil
}

func (m *memoryCredentials) Delete(hubID string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.values, hubID)
	return nil
}

type fixedClock struct{ value time.Time }

func (c fixedClock) Now() time.Time { return c.value }

type randomIDs struct{}

func (randomIDs) New() string { return uuid.NewString() }

func newDesktopTestMaintenanceGate() *usecase.MaintenanceGate { return usecase.NewMaintenanceGate() }

func newHubTestService(t *testing.T) (*HubService, *sqliteadapter.Lifecycle, *memoryCredentials) {
	t.Helper()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "hub.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	credentials := &memoryCredentials{values: make(map[string]string)}
	service := NewHubServiceWithDependencies(
		lifecycle,
		credentials,
		fixedClock{value: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)},
		randomIDs{},
		newDesktopTestMaintenanceGate(),
	)
	return service, lifecycle, credentials
}

func TestHubIdentityIsIndependentFromURLAndSurvivesEditAndDisable(t *testing.T) {
	service, _, _ := newHubTestService(t)
	ctx := context.Background()
	input := CreateHubInput{DisplayName: "Hub A", URL: "http://localhost:17321", CollectionIntervalSeconds: 300, CollectionEnabled: true}
	first, err := service.CreateHub(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.DisplayName = "Hub B"
	second, err := service.CreateHub(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("same URL produced the same Hub ID")
	}
	updated, err := service.UpdateHub(ctx, UpdateHubInput{ID: first.ID, DisplayName: "Hub A2", URL: "http://127.0.0.1:17322", CollectionIntervalSeconds: 600})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != first.ID {
		t.Fatalf("updated Hub ID = %q, want %q", updated.ID, first.ID)
	}
	disabled, err := service.SetHubEnabled(ctx, first.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if disabled.Enabled || disabled.CollectionEnabled {
		t.Fatal("Hub remained enabled")
	}
	if hubs, err := service.GetHubs(ctx); err != nil || len(hubs) != 2 {
		t.Fatalf("Hubs after disable = %d, err = %v", len(hubs), err)
	}
}

func TestDesktopMutationUsesSharedMaintenanceGateButReadsRemainAvailable(t *testing.T) {
	service, _, _ := newHubTestService(t)
	lease, err := service.gate.Acquire(context.Background(), usecase.MaintenanceRestore)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	if _, err := service.GetHubs(context.Background()); err != nil {
		t.Fatalf("read-only API was blocked: %v", err)
	}
	_, err = service.CreateHub(context.Background(), CreateHubInput{DisplayName: "blocked", URL: "http://localhost:17321", CollectionIntervalSeconds: 300})
	if !errors.Is(err, usecase.ErrMaintenanceBusy) {
		t.Fatalf("mutation error = %v, want maintenance busy", err)
	}
}

func TestCredentialFailureLeavesConservativeStateAndNeverWritesSecretToSQLite(t *testing.T) {
	service, lifecycle, credentials := newHubTestService(t)
	ctx := context.Background()
	hub, err := service.CreateHub(ctx, CreateHubInput{DisplayName: "Hub", URL: "http://localhost:17321", CollectionIntervalSeconds: 300, CollectionEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	credentials.writeErr = errors.New("sentinel write failure")
	if _, err := service.SaveCredential(ctx, hub.ID, "sentinel-secret-value"); err == nil {
		t.Fatal("SaveCredential succeeded unexpectedly")
	}
	snapshot, err := service.GetHub(ctx, hub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.CredentialState != "unregistered" {
		t.Fatalf("credential state = %q, want unregistered", snapshot.CredentialState)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var leaked int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits WHERE before_json LIKE '%sentinel-secret-value%' OR after_json LIKE '%sentinel-secret-value%'`).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked != 0 {
		t.Fatal("credential secret was written to SQLite")
	}
}

func TestUnsupportedConnectionPersistsAttemptWithoutCallingStats(t *testing.T) {
	service, lifecycle, _ := newHubTestService(t)
	statsCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/health":
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"evaluation","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
		case "/api/stats":
			statsCalls++
		}
	}))
	defer server.Close()
	hub, err := service.CreateHub(context.Background(), CreateHubInput{DisplayName: "Hub", URL: server.URL, CollectionIntervalSeconds: 300, CollectionEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveCredential(context.Background(), hub.ID, "secret"); err != nil {
		t.Fatal(err)
	}
	checked, err := service.CheckHubConnection(context.Background(), hub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if checked.ConnectionState != "unsupported_contract" {
		t.Fatalf("connection state = %q, want unsupported_contract", checked.ConnectionState)
	}
	if statsCalls != 0 {
		t.Fatalf("stats calls = %d, want 0", statsCalls)
	}
	database, _ := lifecycle.DB()
	var attempts int
	if err := database.QueryRow(`SELECT count(*) FROM hub_connection_attempts WHERE hub_id = ?`, hub.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("connection attempts = %d, want 1", attempts)
	}
}

func TestRestorePendingNeedsNewCredentialAndSuccessfulConnection(t *testing.T) {
	service, lifecycle, _ := newHubTestService(t)
	build := hubapi.BuildIdentity{SchemaVersion: 1, Runtime: "test", CoreBuildID: "core", RuntimeBuildID: "runtime"}
	service.allowlist = hubapi.NewAllowlist(hubapi.Contract{Build: build, UsageUpdatedAt: true})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/health" {
			_, _ = writer.Write([]byte(`{"hubBuild":{"schemaVersion":1,"runtime":"test","coreBuildId":"core","runtimeBuildId":"runtime"}}`))
			return
		}
		_, _ = writer.Write([]byte(`{"devices":[{"deviceId":"device-1","usageUpdatedAt":"2026-08-25T12:00:00Z"}]}`))
	}))
	defer server.Close()
	ctx := context.Background()
	hub, err := service.CreateHub(ctx, CreateHubInput{DisplayName: "Hub", URL: server.URL, CollectionIntervalSeconds: 300, CollectionEnabled: true, Secret: "old"})
	if err != nil {
		t.Fatal(err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO configuration_audits
		(audit_id, occurred_at, actor, action, entity_type, entity_id)
		VALUES (?, ?, 'system', 'restore_succeeded', 'restore', 'operation-test')`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CheckHubConnection(ctx, hub.ID); err == nil {
		t.Fatal("connection check reused a pre-restore credential")
	}
	checked, err := service.GetHub(ctx, hub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if checked.CredentialState != "post_restore_pending" {
		t.Fatalf("state without new save = %q, want post_restore_pending", checked.CredentialState)
	}
	if _, err := service.SaveCredential(ctx, hub.ID, "new"); err != nil {
		t.Fatal(err)
	}
	checked, err = service.CheckHubConnection(ctx, hub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if checked.CredentialState != "registered" || checked.ConnectionState != "connected" {
		t.Fatalf("state after reconfirmation = %q/%q", checked.CredentialState, checked.ConnectionState)
	}
}
