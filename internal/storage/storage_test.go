package storage

import (
	"path/filepath"
	"testing"
	"time"

	"token-monitor-analytics/internal/analytics"
)

func TestStoreSeparatesRawSnapshotAndCalculatedObservation(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "analytics.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveSettings("http://hub.test", 60); err != nil {
		t.Fatal(err)
	}
	gotURL, gotInterval, err := store.GetSettings()
	if err != nil || gotURL != "http://hub.test" || gotInterval != 60 {
		t.Fatalf("settings = %q %d, err=%v", gotURL, gotInterval, err)
	}
	legacySecret, err := store.LegacySecret()
	if err != nil || legacySecret != "" {
		t.Fatalf("legacy secret = %q, err=%v", legacySecret, err)
	}
	_, err = store.SaveSnapshot(time.Unix(0, 0), "http://hub.test/api/stats", []byte(`{"periods":{}}`), []analytics.Observation{{
		Provider: "codex", AccountKey: "sha256:x", AccountLabel: "x", WindowKind: "weekly", WindowLabel: "weekly",
		CalculationStatus: "ok", ObservedAt: "1970-01-01T00:00:00Z", CalculatedAt: "1970-01-01T00:00:00Z",
	}})
	if err != nil {
		t.Fatal(err)
	}
	history, err := store.History(10)
	if err != nil || len(history) != 1 || history[0].Provider != "codex" {
		t.Fatalf("history = %+v, err=%v", history, err)
	}
	count, err := store.SnapshotCount()
	if err != nil || count != 1 {
		t.Fatalf("snapshot count = %d, err=%v", count, err)
	}
}
