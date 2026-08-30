package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

func TestOpenApplicationStorageRecoversBeforeOpeningDatabase(t *testing.T) {
	var calls []string
	root := t.TempDir()
	wantRecovery := domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryRolledBack}
	dependencies := applicationStorageDependencies{
		userConfigDir: func() (string, error) {
			calls = append(calls, "config")
			return root, nil
		},
		mkdirAll: func(path string, mode os.FileMode) error {
			calls = append(calls, "mkdir")
			if path != filepath.Join(root, "TokenMonitorAnalytics") || mode != 0o700 {
				t.Fatalf("data directory/mode = %q/%#o", path, mode)
			}
			return nil
		},
		recover: func(_ context.Context, path string) (domain.RestoreRecoveryResult, error) {
			calls = append(calls, "recover")
			if path != filepath.Join(root, "TokenMonitorAnalytics") {
				t.Fatalf("recovery directory = %q", path)
			}
			return wantRecovery, nil
		},
		openLifecycle: func(_ context.Context, path string) (*sqliteadapter.Lifecycle, error) {
			calls = append(calls, "open")
			if path != filepath.Join(root, "TokenMonitorAnalytics", sqliteadapter.RestoreDatabaseName) {
				t.Fatalf("database path = %q", path)
			}
			return &sqliteadapter.Lifecycle{}, nil
		},
	}

	storage, err := openApplicationStorageWithDependencies(t.Context(), dependencies)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"config", "mkdir", "recover", "open"}) {
		t.Fatalf("startup order = %v", calls)
	}
	if storage.recovery != wantRecovery {
		t.Fatalf("recovery = %#v", storage.recovery)
	}
}

func TestOpenApplicationStorageStopsBeforeDatabaseOpenWhenRecoveryFails(t *testing.T) {
	wantErr := errors.New("unsafe restore journal")
	openCalled := false
	dependencies := defaultApplicationStorageDependencies()
	dependencies.userConfigDir = func() (string, error) { return t.TempDir(), nil }
	dependencies.recover = func(context.Context, string) (domain.RestoreRecoveryResult, error) {
		return domain.RestoreRecoveryResult{}, wantErr
	}
	dependencies.openLifecycle = func(context.Context, string) (*sqliteadapter.Lifecycle, error) {
		openCalled = true
		return nil, errors.New("database must not open")
	}

	if _, err := openApplicationStorageWithDependencies(t.Context(), dependencies); !errors.Is(err, wantErr) {
		t.Fatalf("startup error = %v, want recovery error", err)
	}
	if openCalled {
		t.Fatal("database was opened after restore recovery failed")
	}
}

func TestOpenApplicationStorageUnknownJournalDoesNotCreateDatabase(t *testing.T) {
	root := t.TempDir()
	dataDirectory := filepath.Join(root, "TokenMonitorAnalytics")
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(dataDirectory, sqliteadapter.RestoreJournalName)
	if err := os.WriteFile(journalPath, []byte(`{"journalVersion":1,"stage":"unknown"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dependencies := defaultApplicationStorageDependencies()
	dependencies.userConfigDir = func() (string, error) { return root, nil }

	if _, err := openApplicationStorageWithDependencies(t.Context(), dependencies); err == nil {
		t.Fatal("unknown restore journal did not stop startup")
	}
	if _, err := os.Lstat(filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)); !os.IsNotExist(err) {
		t.Fatalf("database was created before restore recovery completed: %v", err)
	}
	if contents, err := os.ReadFile(journalPath); err != nil || string(contents) != `{"journalVersion":1,"stage":"unknown"}` {
		t.Fatalf("unsafe restore journal was modified: %q/%v", contents, err)
	}
}
