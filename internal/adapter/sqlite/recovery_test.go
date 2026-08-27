package sqlite

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestRecoverPendingRestoreAllowsNoJournal(t *testing.T) {
	t.Parallel()
	if _, err := RecoverPendingRestore(t.Context(), t.TempDir()); err != nil {
		t.Fatalf("recover without journal: %v", err)
	}
}

func TestRecoverPendingRestoreStopsBeforeUnknownJournal(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, RestoreJournalName), []byte(`{"stage":"unknown"}`), 0o600); err != nil {
		t.Fatalf("write journal: %v", err)
	}
	if _, err := RecoverPendingRestore(t.Context(), directory); err == nil {
		t.Fatal("expected unknown journal to stop startup")
	}
}

func TestRecoverPendingRestoreCleansSimulatedCrashBeforeJournalCreation(t *testing.T) {
	directory := t.TempDir()
	current := filepath.Join(directory, RestoreDatabaseName)
	incoming := filepath.Join(directory, RestoreIncomingDatabaseName)
	if err := os.WriteFile(current, []byte("current"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(incoming, []byte("incoming"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := RecoverPendingRestore(t.Context(), directory)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != domain.RestoreRecoveryNone {
		t.Fatalf("recovery status = %q", result.Status)
	}
	got, err := os.ReadFile(current)
	if err != nil || string(got) != "current" {
		t.Fatalf("current database was modified: %q/%v", got, err)
	}
	if _, err := os.Lstat(incoming); !os.IsNotExist(err) {
		t.Fatal("unmoved incoming database remains")
	}
}

func TestRecoverPendingRestoreDoesNotModifyCandidatesForInvalidJournal(t *testing.T) {
	directory := t.TempDir()
	current := filepath.Join(directory, RestoreDatabaseName)
	original := filepath.Join(directory, RestoreOriginalDatabaseName)
	incoming := filepath.Join(directory, RestoreIncomingDatabaseName)
	journal := filepath.Join(directory, RestoreJournalName)
	files := map[string][]byte{
		current:  []byte("current"),
		original: []byte("original"),
		incoming: []byte("incoming"),
		journal:  []byte(`{"journalVersion":1,"stage":"unknown"}`),
	}
	for path, contents := range files {
		if err := os.WriteFile(path, contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := RecoverPendingRestore(t.Context(), directory); err == nil {
		t.Fatal("invalid journal was accepted")
	}
	for path, want := range files {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("candidate %s was removed: %v", filepath.Base(path), err)
		}
		if string(got) != string(want) {
			t.Fatalf("candidate %s was modified", filepath.Base(path))
		}
	}
}

func TestRecoverPendingRestoreRollsBackSimulatedCrashAtOriginalMovedStage(t *testing.T) {
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	dataDirectory, err := lifecycle.ApplicationDataDirectory()
	if err != nil {
		t.Fatal(err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := checkpointRestoreDatabase(context.Background(), database); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatal(err)
	}
	paths, err := newRestorePaths(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if err := moveRestoreFile(paths.root, candidate, paths.incoming); err != nil {
		t.Fatal(err)
	}
	journal := restoreJournal{
		JournalVersion: restoreJournalVersion, Stage: restoreStagePrepared,
		OperationID: "operation-one", ArtifactSHA256: repeatHex("d"),
		BackupFormatVersion: manifest.FormatVersion, SchemaVersion: manifest.SchemaVersion,
		RestoredAt: time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano), AuditID: "audit-one",
	}
	journal.OriginalWAL, _ = restoreFileExists(paths.current + "-wal")
	journal.OriginalSHM, _ = restoreFileExists(paths.current + "-shm")
	if err := writeRestoreJournal(paths, journal); err != nil {
		t.Fatal(err)
	}
	if err := moveRestoreFile(paths.root, paths.current, paths.original); err != nil {
		t.Fatal(err)
	}
	if journal.OriginalWAL {
		if err := moveRestoreFile(paths.root, paths.current+"-wal", paths.original+"-wal"); err != nil {
			t.Fatal(err)
		}
	}
	if journal.OriginalSHM {
		if err := moveRestoreFile(paths.root, paths.current+"-shm", paths.original+"-shm"); err != nil {
			t.Fatal(err)
		}
	}
	journal.Stage = restoreStageOriginalMoved
	if err := writeRestoreJournal(paths, journal); err != nil {
		t.Fatal(err)
	}
	result, err := RecoverPendingRestore(t.Context(), dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != domain.RestoreRecoveryRolledBack {
		t.Fatalf("recovery status = %q", result.Status)
	}
	restored, err := sql.Open("sqlite", sqliteReadOnlyDSN(paths.current))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restored.Close() }()
	var theme string
	if err := restored.QueryRowContext(t.Context(), `SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "system" {
		t.Fatalf("recovered theme = %q, want original system", theme)
	}
}
