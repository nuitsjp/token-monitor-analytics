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

func TestStoreSavesSubscriptionAndAccountOptions(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "analytics.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	_, err = store.SaveSnapshot(time.Unix(0, 0), "http://hub.test/api/stats", []byte(`{"periods":{}}`), []analytics.Observation{{
		Provider: "codex", AccountKey: "sha256:x", AccountLabel: "Personal", WindowKind: "weekly", WindowLabel: "weekly",
		CalculationStatus: "missing_period", ObservedAt: "1970-01-01T00:00:00Z", CalculatedAt: "1970-01-01T00:00:00Z",
	}})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.SaveSubscription(Subscription{
		Provider: "codex", AccountKey: "sha256:x", AccountLabel: "Personal", PlanName: "Plus", MonthlyPriceUSD: 20,
	})
	if err != nil || saved.ID == 0 {
		t.Fatalf("saved = %+v, err=%v", saved, err)
	}
	saved.MonthlyPriceUSD = 25
	updated, err := store.SaveSubscription(saved)
	if err != nil || updated.ID != saved.ID {
		t.Fatalf("updated = %+v, err=%v", updated, err)
	}
	subscriptions, err := store.Subscriptions()
	if err != nil || len(subscriptions) != 1 || subscriptions[0].MonthlyPriceUSD != 25 {
		t.Fatalf("subscriptions = %+v, err=%v", subscriptions, err)
	}
	accounts, err := store.Accounts()
	if err != nil || len(accounts) != 1 || accounts[0].AccountKey != "sha256:x" {
		t.Fatalf("accounts = %+v, err=%v", accounts, err)
	}
	if err := store.DeleteSubscription(saved.ID); err != nil {
		t.Fatal(err)
	}
	if subscriptions, err := store.Subscriptions(); err != nil || len(subscriptions) != 0 {
		t.Fatalf("subscriptions after delete = %+v, err=%v", subscriptions, err)
	}
}
