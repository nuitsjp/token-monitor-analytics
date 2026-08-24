package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
	"token-monitor-analytics/internal/analytics"
	"token-monitor-analytics/internal/cloudserver"
	"token-monitor-analytics/internal/storage"
)

type fakeCredentialStore struct {
	secret   string
	found    bool
	readErr  error
	writeErr error
}

func (f *fakeCredentialStore) Read() (string, bool, error) {
	return f.secret, f.found, f.readErr
}

func (f *fakeCredentialStore) Write(secret string) error {
	if f.writeErr != nil {
		return f.writeErr
	}
	f.secret = secret
	f.found = true
	return nil
}

func (f *fakeCredentialStore) Delete() error {
	f.secret = ""
	f.found = false
	return nil
}

func TestSaveSettingsWritesSecretToCredentialStoreOnly(t *testing.T) {
	store := openTestStore(t)
	credentials := &fakeCredentialStore{}
	service, err := NewService(store, credentials, &fakeCredentialStore{})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveSettings(Settings{HubURL: "http://hub.test", Secret: "secret", IntervalSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	if credentials.secret != "secret" || !credentials.found {
		t.Fatal("secret was not written to the credential store")
	}
	legacySecret, err := store.LegacySecret()
	if err != nil || legacySecret != "" {
		t.Fatalf("SQLite secret = %q, err=%v", legacySecret, err)
	}
	settings := service.GetSettings()
	if settings.Secret != "" || !settings.SecretConfigured {
		t.Fatalf("settings exposed or lost credential state: %+v", settings)
	}
}

func TestFetchNowUsesCredentialStoreSecret(t *testing.T) {
	const secret = "credential-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("unexpected Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"periods":{},"limits":{"providers":[]}}`))
	}))
	defer server.Close()

	store := openTestStore(t)
	credentials := &fakeCredentialStore{secret: secret, found: true}
	service, err := NewService(store, credentials, &fakeCredentialStore{})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveSettings(Settings{HubURL: server.URL, IntervalSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	result, err := service.FetchNow()
	if err != nil {
		t.Fatal(err)
	}
	if result.SnapshotID == 0 {
		t.Fatal("snapshot was not saved")
	}
}

func TestNewServiceMigratesLegacySecretAfterCredentialWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analytics.db")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	insertLegacySecret(t, path, "legacy-secret")

	credentials := &fakeCredentialStore{found: true}
	if _, err := NewService(store, credentials, &fakeCredentialStore{}); err != nil {
		t.Fatal(err)
	}
	if credentials.secret != "legacy-secret" {
		t.Fatal("legacy secret was not migrated")
	}
	legacySecret, err := store.LegacySecret()
	if err != nil || legacySecret != "" {
		t.Fatalf("legacy secret remains in SQLite: %q, err=%v", legacySecret, err)
	}
}

func TestNewServiceKeepsLegacySecretWhenCredentialWriteFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analytics.db")
	store, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	insertLegacySecret(t, path, "legacy-secret")

	credentials := &fakeCredentialStore{writeErr: errors.New("write failed")}
	if _, err := NewService(store, credentials, &fakeCredentialStore{}); err == nil {
		t.Fatal("expected migration failure")
	}
	legacySecret, err := store.LegacySecret()
	if err != nil || legacySecret != "legacy-secret" {
		t.Fatalf("legacy secret was removed after failed migration: %q, err=%v", legacySecret, err)
	}
}

func TestDashboardCalculatesSubscriptionValueAndExports(t *testing.T) {
	store := openTestStore(t)
	raw := []byte(`{
"periods":{"month":{"totalTokens":1000,"costUsd":80,"clients":{"codex":1000},"clientCosts":{"codex":80}}},
"limits":{"providers":[{"provider":"codex","accountKey":"sha256:x"}]},"devices":[]}`)
	_, err := store.SaveSnapshot(time.Now(), "http://hub.test/api/stats", raw, []analytics.Observation{{
		Provider: "codex", AccountKey: "sha256:x", AccountLabel: "Personal", WindowKind: "billing",
		PeriodKey: "month", UsageUSD: 80, UtilizationPercent: 40, EstimatedLimitUSD: 200,
		CalculationStatus: "ok", ObservedAt: "2026-08-23T00:00:00Z", CalculatedAt: "2026-08-23T00:00:00Z",
	}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, &fakeCredentialStore{}, &fakeCredentialStore{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SaveSubscription(SubscriptionInput{
		Provider: "codex", AccountKey: "sha256:x", AccountLabel: "Personal", PlanName: "Plus", MonthlyPriceUSD: 20,
	}); err != nil {
		t.Fatal(err)
	}
	dashboard, err := service.GetDashboard()
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.Subscriptions) != 1 {
		t.Fatalf("dashboard = %+v", dashboard)
	}
	metric := dashboard.Subscriptions[0]
	if metric.ActualValueMultiplier == nil || *metric.ActualValueMultiplier != 4 || metric.EstimatedMaxValueMultiplier == nil || *metric.EstimatedMaxValueMultiplier != 10 {
		t.Fatalf("metric = %+v", metric)
	}
	jsonExport, err := service.ExportJSON()
	if err != nil || !strings.Contains(jsonExport, `"planName": "Plus"`) {
		t.Fatalf("JSON export error=%v", err)
	}
	csvExport, err := service.ExportCSV()
	if err != nil || !strings.HasPrefix(csvExport, "\uFEFF") || !strings.Contains(csvExport, "monthly_price_usd") || !strings.Contains(csvExport, "codex") {
		t.Fatalf("CSV export error=%v", err)
	}
}

func TestCloudSyncUploadsSnapshotsAndAdvancesCursor(t *testing.T) {
	const cloudSecret = "cloud-secret"
	var received cloudSyncRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+cloudSecret {
			t.Error("cloud Authorization header is missing")
		}
		if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		accepted := int64(0)
		if len(received.Snapshots) > 0 {
			accepted = received.Snapshots[len(received.Snapshots)-1].LocalID
		}
		_ = json.NewEncoder(writer).Encode(cloudSyncResponse{AcceptedThrough: accepted})
	}))
	defer server.Close()

	store := openTestStore(t)
	_, err := store.SaveSnapshot(time.Now(), "http://hub.test/api/stats", []byte(`{"periods":{"month":{}}}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	cloudCredentials := &fakeCredentialStore{secret: cloudSecret, found: true}
	service, err := NewService(store, &fakeCredentialStore{}, cloudCredentials)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveCloudSettings(CloudSettings{URL: server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	result, err := service.SyncCloudNow()
	if err != nil {
		t.Fatal(err)
	}
	if result.UploadedSnapshots != 1 || result.AcceptedThrough == 0 || received.DeviceID == "" {
		t.Fatalf("sync result=%+v payload=%+v", result, received)
	}
	config, err := store.GetCloudConfig()
	if err != nil || config.SyncCursor != result.AcceptedThrough {
		t.Fatalf("cloud config=%+v err=%v", config, err)
	}
}

func TestBackupEnvelopeRejectsTamperingAndRestores(t *testing.T) {
	store := openTestStore(t)
	_, err := store.SaveSnapshot(time.Now(), "http://hub.test/api/stats", []byte(`{"periods":{"month":{}}}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, &fakeCredentialStore{}, &fakeCredentialStore{})
	if err != nil {
		t.Fatal(err)
	}
	backup, err := service.CreateBackup()
	if err != nil {
		t.Fatal(err)
	}
	if err := service.RestoreBackup(strings.Replace(backup, `"version": 1`, `"version": 2`, 1)); err == nil {
		t.Fatal("unsupported backup version was accepted")
	}
	if err := service.RestoreBackup(strings.Replace(backup, `"fetchedAt"`, `"tamperedFetchedAt"`, 1)); err == nil {
		t.Fatal("tampered backup was accepted")
	}
	if err := service.RestoreBackup(backup); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopToCloudServerIntegration(t *testing.T) {
	cloud, err := cloudserver.New(filepath.Join(t.TempDir(), "cloud.db"), "cloud-secret")
	if err != nil {
		t.Fatal(err)
	}
	defer cloud.Close()
	server := httptest.NewServer(cloud.Handler())
	defer server.Close()

	store := openTestStore(t)
	_, err = store.SaveSnapshot(time.Now(), "http://hub.test/api/stats", []byte(`{
"periods":{"month":{"totalTokens":100,"costUsd":2,"clients":{"codex":100},"clientCosts":{"codex":2}}},
"limits":{"providers":[{"provider":"codex","accountKey":"account"}]}}`), []analytics.Observation{{
		Provider: "codex", AccountKey: "account", WindowKind: "weekly", ObservedAt: "2026-08-23T00:00:00Z",
	}})
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(store, &fakeCredentialStore{}, &fakeCredentialStore{secret: "cloud-secret", found: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.SaveCloudSettings(CloudSettings{URL: server.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SyncCloudNow(); err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/dashboard", nil)
	request.Header.Set("Authorization", "Bearer cloud-secret")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var dashboard cloudserver.Dashboard
	if err := json.NewDecoder(response.Body).Decode(&dashboard); err != nil {
		t.Fatal(err)
	}
	if dashboard.DeviceCount != 1 || dashboard.Analysis.TotalCostUSD != 2 || len(dashboard.Observations) != 1 {
		t.Fatalf("cloud dashboard=%+v", dashboard)
	}
}

func openTestStore(t *testing.T) *storage.Store {
	t.Helper()
	store, err := storage.Open(filepath.Join(t.TempDir(), "analytics.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func insertLegacySecret(t *testing.T, path, secret string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec(`INSERT INTO settings(key, value) VALUES('secret', ?)`, secret); err != nil {
		t.Fatal(err)
	}
}
