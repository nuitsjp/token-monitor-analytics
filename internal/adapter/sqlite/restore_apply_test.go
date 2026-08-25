package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type restorePointFailure string

func (f restorePointFailure) Check(point string) error {
	if point == string(f) {
		return errors.New("injected restore failure")
	}
	return nil
}

type restoreCancelInjector struct {
	point  string
	cancel context.CancelFunc
}

func (i restoreCancelInjector) Check(point string) error {
	if point == i.point {
		i.cancel()
	}
	return nil
}

func TestRestoreApplierRoundTripsLogicalContentsAndAddsOneGlobalAudit(t *testing.T) {
	ctx := context.Background()
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	defer lifecycle.Close()
	want, err := logicalSnapshot(ctx, candidate)
	if err != nil {
		t.Fatal(err)
	}
	applier, err := NewRestoreApplier(lifecycle, nil)
	if err != nil {
		t.Fatal(err)
	}
	restoredAt := time.Date(2026, 8, 26, 1, 2, 3, 4, time.UTC)
	result, err := applier.ApplyValidatedRestore(ctx, candidate, "operation-one", repeatHex("a"), manifest, "audit-one", restoredAt)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-RESTORE-04 atomic database and sidecar replacement", func(t *testing.T) {
		if result.Warning != "" || result.RollbackSucceeded {
			t.Fatalf("unexpected result: %+v", result)
		}
		database, err := lifecycle.DB()
		if err != nil {
			t.Fatal(err)
		}
		got, err := logicalSnapshotDatabase(ctx, database, "audit-one")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatal("restored logical contents differ from candidate")
		}
		var count int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits WHERE entity_type = 'restore' AND action = 'restore_succeeded'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("global restore audit count = %d, want 1", count)
		}
		assertRestoreWorkspaceClean(t, lifecycle)
	})
	t.Run("P1-RESTORE-10 success audit records artifact and versions", func(t *testing.T) {
		database, err := lifecycle.DB()
		if err != nil {
			t.Fatal(err)
		}
		var afterJSON string
		if err := database.QueryRow(`SELECT after_json FROM configuration_audits WHERE audit_id = 'audit-one' AND action = 'restore_succeeded'`).Scan(&afterJSON); err != nil {
			t.Fatal(err)
		}
		var audit struct {
			ArtifactSHA256 string `json:"artifactSha256"`
			FormatVersion  int    `json:"formatVersion"`
			SchemaVersion  int64  `json:"schemaVersion"`
			RestoredAt     string `json:"restoredAt"`
		}
		if err := json.Unmarshal([]byte(afterJSON), &audit); err != nil {
			t.Fatalf("restore audit JSON = %q: %v", afterJSON, err)
		}
		if audit.ArtifactSHA256 != repeatHex("a") || audit.FormatVersion != manifest.FormatVersion || audit.SchemaVersion != manifest.SchemaVersion || audit.RestoredAt != "2026-08-26T01:02:03.000000004Z" {
			t.Fatalf("restore audit payload = %#v", audit)
		}
	})
}

func TestRestoreApplierRollsBackEveryPrecommitFailurePoint(t *testing.T) {
	points := []string{
		"validated", "checkpointed", "closed", "candidate_staged", "journal_prepared",
		"original_database_moved", "original_wal_moved", "original_shm_moved",
		"journal_original_moved", "replacement_moved", "journal_replacement_moved",
		"replacement_validated", "reopened", "audit_written", "journal_audit_written", "contents_verified", "verified",
	}
	t.Run("P1-RESTORE-05 failed validation or apply preserves the original database", func(t *testing.T) {
		for _, point := range points {
			t.Run(point, func(t *testing.T) {
				ctx := context.Background()
				lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
				defer lifecycle.Close()
				applier, err := NewRestoreApplier(lifecycle, restorePointFailure(point))
				if err != nil {
					t.Fatal(err)
				}
				result, err := applier.ApplyValidatedRestore(ctx, candidate, "operation-one", repeatHex("b"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC))
				if err == nil {
					t.Fatal("restore unexpectedly succeeded")
				}
				if !result.RollbackSucceeded {
					t.Fatalf("rollback was not reported successful: %+v, %v", result, err)
				}
				database, dbErr := lifecycle.DB()
				if dbErr != nil {
					t.Fatal(dbErr)
				}
				var theme string
				if err := database.QueryRowContext(ctx, `SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
					t.Fatal(err)
				}
				if theme != "system" {
					t.Fatalf("operational theme = %q, want original system", theme)
				}
				var audits int
				if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits WHERE action = 'restore_succeeded'`).Scan(&audits); err != nil {
					t.Fatal(err)
				}
				if audits != 0 {
					t.Fatalf("rolled back restore audits = %d, want 0", audits)
				}
			})
		}
	})
}

func TestRestoreApplierTreatsPostcommitFailureAsCleanupWarning(t *testing.T) {
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	applier, err := NewRestoreApplier(lifecycle, restorePointFailure("committed"))
	if err != nil {
		t.Fatal(err)
	}
	result, err := applier.ApplyValidatedRestore(context.Background(), candidate, "operation-one", repeatHex("c"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.Warning == "" {
		t.Fatal("postcommit cleanup warning is missing")
	}
	dataDirectory, _ := lifecycle.ApplicationDataDirectory()
	if err := lifecycle.Close(); err != nil {
		t.Fatal(err)
	}
	recovery, err := RecoverPendingRestore(dataDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Status != domain.RestoreRecoveryCommittedCleaned {
		t.Fatalf("recovery status = %q", recovery.Status)
	}
	if err := lifecycle.Open(context.Background(), filepath.Join(dataDirectory, RestoreDatabaseName)); err != nil {
		t.Fatal(err)
	}
	defer lifecycle.Close()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var theme string
	if err := database.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "dark" {
		t.Fatalf("committed recovery theme = %q, want dark", theme)
	}
}

func TestRestoreApplierRevalidatesCandidateImmediatelyBeforeSwap(t *testing.T) {
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	defer lifecycle.Close()
	file, err := os.OpenFile(candidate, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("tampered")); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	applier, err := NewRestoreApplier(lifecycle, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := applier.ApplyValidatedRestore(context.Background(), candidate, "operation-one", repeatHex("f"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC))
	if err == nil {
		t.Fatal("tampered candidate was applied")
	}
	if !result.RollbackSucceeded {
		t.Fatal("pre-swap rejection did not preserve the operational database")
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var theme string
	if err := database.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "system" {
		t.Fatalf("operational theme = %q, want system", theme)
	}
}

func TestRestoreApplierHonorsCancellationBeforeFirstOriginalMove(t *testing.T) {
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	defer lifecycle.Close()
	ctx, cancel := context.WithCancel(context.Background())
	applier, err := NewRestoreApplier(lifecycle, restoreCancelInjector{point: "journal_prepared", cancel: cancel})
	if err != nil {
		t.Fatal(err)
	}
	result, err := applier.ApplyValidatedRestore(ctx, candidate, "operation-one", repeatHex("1"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC))
	if !errors.Is(err, context.Canceled) || !result.RollbackSucceeded {
		t.Fatalf("canceled restore result/error = %+v/%v", result, err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var theme string
	if err := database.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "system" {
		t.Fatalf("operational theme = %q, want system", theme)
	}
}

func TestRestoreApplierFinishesAtomicPhaseAfterOriginalMoveDespiteCancellation(t *testing.T) {
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	defer lifecycle.Close()
	ctx, cancel := context.WithCancel(context.Background())
	applier, err := NewRestoreApplier(lifecycle, restoreCancelInjector{point: "original_database_moved", cancel: cancel})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := applier.ApplyValidatedRestore(ctx, candidate, "operation-one", repeatHex("2"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var theme string
	if err := database.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "dark" {
		t.Fatalf("restored theme = %q, want dark", theme)
	}
}

func TestRestoreApplierRollsBackWhenSuccessAuditCannotBeInserted(t *testing.T) {
	ctx := context.Background()
	lifecycle, candidate, manifest := newRestoreApplyFixture(t, "dark")
	defer lifecycle.Close()
	database, err := sql.Open("sqlite", sqliteReadWriteDSN(candidate))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO configuration_audits
		(audit_id, occurred_at, actor, action, entity_type, entity_id)
		VALUES ('audit-one', '2026-08-26T00:00:00Z', 'test', 'test', 'test', 'test')`); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest, err = manifestForRestoreDatabase(ctx, candidate, manifest)
	if err != nil {
		t.Fatal(err)
	}
	applier, err := NewRestoreApplier(lifecycle, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := applier.ApplyValidatedRestore(ctx, candidate, "operation-one", repeatHex("3"), manifest, "audit-one", time.Date(2026, 8, 26, 1, 2, 3, 0, time.UTC))
	if err == nil || !result.RollbackSucceeded {
		t.Fatalf("audit failure result/error = %+v/%v", result, err)
	}
	operational, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var theme string
	if err := operational.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatal(err)
	}
	if theme != "system" {
		t.Fatalf("operational theme = %q, want system", theme)
	}
}

func newRestoreApplyFixture(t *testing.T, candidateTheme string) (*Lifecycle, string, domain.BackupManifest) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(root, RestoreDatabaseName)); err != nil {
		t.Fatal(err)
	}
	candidateDirectory, err := os.MkdirTemp(root, "restore-validated-")
	if err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(candidateDirectory, "data.sqlite3")
	if err := lifecycle.Backup(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", sqliteReadWriteDSN(candidate))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE display_settings SET theme = ? WHERE singleton = 1`, candidateTheme); err != nil {
		_ = database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	manifest := domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: CurrentSchemaVersion,
		AppVersion:    "test",
		CreatedAt:     time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC),
		Database:      domain.BackupDatabaseManifest{Path: "data.sqlite3"},
	}
	manifest, err = manifestForRestoreDatabase(ctx, candidate, manifest)
	if err != nil {
		t.Fatal(err)
	}
	return lifecycle, candidate, manifest
}

func repeatHex(value string) string {
	return strings.Repeat(value, 64)
}

func assertRestoreWorkspaceClean(t *testing.T, lifecycle *Lifecycle) {
	t.Helper()
	dataDirectory, err := lifecycle.ApplicationDataDirectory()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{RestoreOriginalDatabaseName, RestoreIncomingDatabaseName, RestoreJournalName, restoreJournalTemporaryName} {
		if _, err := os.Lstat(filepath.Join(dataDirectory, name)); !os.IsNotExist(err) {
			t.Fatalf("fixed restore artifact remains: %s", name)
		}
	}
}
