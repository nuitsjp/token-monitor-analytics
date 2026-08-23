package app

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
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
	service, err := NewService(store, credentials)
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
	service, err := NewService(store, credentials)
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
	if _, err := NewService(store, credentials); err != nil {
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
	if _, err := NewService(store, credentials); err == nil {
		t.Fatal("expected migration failure")
	}
	legacySecret, err := store.LegacySecret()
	if err != nil || legacySecret != "legacy-secret" {
		t.Fatalf("legacy secret was removed after failed migration: %q, err=%v", legacySecret, err)
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
