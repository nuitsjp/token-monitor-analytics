package acceptance

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

const (
	restoreCrashHelperModeEnv    = "TMA_AC_P1_24_CRASH_HELPER"
	restoreCrashDataDirectoryEnv = "TMA_AC_P1_24_DATA_DIRECTORY"
	restoreCrashCandidatePathEnv = "TMA_AC_P1_24_CANDIDATE_PATH"
	restoreCrashFailurePointEnv  = "TMA_AC_P1_24_FAILURE_POINT"
	restoreCrashExitCode         = 86
	restoreCrashOperationID      = "operation-ac-p1-24"
	restoreCrashAuditID          = "audit-ac-p1-24"
	restoreCrashArtifactSHA256   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

var restoreCrashFailurePoints = []string{
	"journal_prepared",
	"original_database_moved",
	"original_wal_moved",
	"original_shm_moved",
	"journal_original_moved",
	"replacement_moved",
	"journal_replacement_moved",
	"reopened",
	"audit_written",
	"journal_audit_written",
	"contents_verified",
	"verified",
	"committed",
}

func TestACP124RestoreCrashRecoveryAtEverySwapStage(t *testing.T) {
	t.Run("P1-RESTORE-09 startup journal recovery after process stop", func(t *testing.T) {
		for _, point := range restoreCrashFailurePoints {
			point := point
			t.Run("AC-P1-24/"+point, func(t *testing.T) {
				dataDirectory, candidatePath, original, replacement := prepareRestoreCrashFixture(t)
				command := exec.CommandContext(context.Background(), os.Args[0], "-test.run=^TestACP124RestoreCrashHelper$", "-test.count=1")
				command.Env = append(os.Environ(),
					restoreCrashHelperModeEnv+"=1",
					restoreCrashDataDirectoryEnv+"="+dataDirectory,
					restoreCrashCandidatePathEnv+"="+candidatePath,
					restoreCrashFailurePointEnv+"="+point,
				)
				output, err := command.CombinedOutput()
				var exitError *exec.ExitError
				if !errors.As(err, &exitError) || exitError.ExitCode() != restoreCrashExitCode {
					t.Fatalf("crash helper point %q = %v, output:\n%s", point, err, output)
				}
				assertRestoreCrashJournalHasNoAbsolutePath(t, dataDirectory)

				recovery, err := sqliteadapter.RecoverPendingRestore(t.Context(), dataDirectory)
				if err != nil {
					t.Fatalf("recover point %q: %v", point, err)
				}
				lifecycle := &sqliteadapter.Lifecycle{}
				if err := lifecycle.Open(context.Background(), filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = lifecycle.Close() })
				database, err := lifecycle.DB()
				if err != nil {
					t.Fatal(err)
				}
				if point != "committed" {
					if recovery.Status != domain.RestoreRecoveryRolledBack {
						t.Fatalf("recovery status at %q = %q, want %q", point, recovery.Status, domain.RestoreRecoveryRolledBack)
					}
					after, err := acceptanceLogicalContents(context.Background(), database, "")
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(original, after) {
						t.Fatalf("original logical contents changed after recovery at %q", point)
					}
					return
				}

				if recovery.Status != domain.RestoreRecoveryCommittedCleaned {
					t.Fatalf("recovery status at committed = %q, want %q", recovery.Status, domain.RestoreRecoveryCommittedCleaned)
				}
				after, err := acceptanceLogicalContents(context.Background(), database, restoreCrashAuditID)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(replacement, after) {
					t.Fatal("committed replacement logical contents differ after excluding the restore audit")
				}
				var total, restores int
				if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM configuration_audits`).Scan(&total); err != nil {
					t.Fatal(err)
				}
				if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM configuration_audits WHERE audit_id = ? AND action = 'restore_succeeded' AND entity_type = 'restore'`, restoreCrashAuditID).Scan(&restores); err != nil {
					t.Fatal(err)
				}
				if total != 1 || restores != 1 {
					t.Fatalf("committed audit total/restore = %d/%d, want 1/1", total, restores)
				}
			})
		}
	})
}

func TestACP124RestoreCrashHelper(t *testing.T) {
	if os.Getenv(restoreCrashHelperModeEnv) != "1" {
		return
	}
	dataDirectory := os.Getenv(restoreCrashDataDirectoryEnv)
	candidatePath := os.Getenv(restoreCrashCandidatePathEnv)
	failurePoint := os.Getenv(restoreCrashFailurePointEnv)
	if dataDirectory == "" || candidatePath == "" || failurePoint == "" {
		t.Fatal("restore crash helper environment is incomplete")
	}
	manifest, err := acceptanceRestoreManifest(candidatePath)
	if err != nil {
		t.Fatal(err)
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)); err != nil {
		t.Fatal(err)
	}
	applier, err := sqliteadapter.NewRestoreApplier(lifecycle, restoreCrashExitInjector{point: failurePoint})
	if err != nil {
		t.Fatal(err)
	}
	_, err = applier.ApplyValidatedRestore(
		context.Background(), candidatePath, restoreCrashOperationID, restoreCrashArtifactSHA256,
		manifest, restoreCrashAuditID, time.Date(2026, 8, 26, 1, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("restore did not reach crash point %q: %v", failurePoint, err)
	}
	t.Fatalf("restore completed without reaching crash point %q", failurePoint)
}

type restoreCrashExitInjector struct{ point string }

func (i restoreCrashExitInjector) Check(point string) error {
	if point == i.point {
		os.Exit(restoreCrashExitCode)
	}
	return nil
}

func prepareRestoreCrashFixture(t *testing.T) (string, string, map[string][][]string, map[string][][]string) {
	t.Helper()
	ctx := context.Background()
	workspace, err := filepath.Abs(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dataDirectory := filepath.Join(workspace, "application-data")
	if err := os.Mkdir(dataDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	currentPath := filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, currentPath); err != nil {
		t.Fatal(err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE display_settings SET theme = 'light' WHERE singleton = 1`); err != nil {
		t.Fatal(err)
	}
	candidateDirectory := filepath.Join(dataDirectory, "restore-validated-ac-p1-24")
	if err := os.Mkdir(candidateDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	candidatePath := filepath.Join(candidateDirectory, "data.sqlite3")
	if err := lifecycle.Backup(ctx, candidatePath); err != nil {
		t.Fatal(err)
	}
	replacementDatabase := openAcceptanceReadOnlyDatabase(t, candidatePath)
	replacement, err := acceptanceLogicalContents(ctx, replacementDatabase, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := replacementDatabase.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE display_settings SET theme = 'dark' WHERE singleton = 1`); err != nil {
		t.Fatal(err)
	}
	original, err := acceptanceLogicalContents(ctx, database, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatal(err)
	}
	return dataDirectory, candidatePath, original, replacement
}

func openAcceptanceReadOnlyDatabase(t *testing.T, path string) *sql.DB {
	t.Helper()
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	urlPath := filepath.ToSlash(absolutePath)
	if filepath.VolumeName(absolutePath) != "" {
		urlPath = "/" + urlPath
	}
	dsn := (&url.URL{Scheme: "file", Path: urlPath, RawQuery: "mode=ro&immutable=1"}).String()
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	if err := database.PingContext(context.Background()); err != nil {
		if closeErr := database.Close(); closeErr != nil {
			t.Fatalf("ping database: %v (close: %v)", err, closeErr)
		}
		t.Fatal(err)
	}
	return database
}

func acceptanceRestoreManifest(path string) (domain.BackupManifest, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return domain.BackupManifest{}, fmt.Errorf("read restore crash candidate: %w", err)
	}
	digest := sha256.Sum256(contents)
	return domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: sqliteadapter.CurrentSchemaVersion,
		AppVersion:    "acceptance",
		CreatedAt:     time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC),
		Database: domain.BackupDatabaseManifest{
			Path: "data.sqlite3", SizeBytes: int64(len(contents)), SHA256: hex.EncodeToString(digest[:]),
		},
	}, nil
}

func assertRestoreCrashJournalHasNoAbsolutePath(t *testing.T, dataDirectory string) {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join(dataDirectory, sqliteadapter.RestoreJournalName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), dataDirectory) || strings.Contains(string(contents), filepath.VolumeName(dataDirectory)) {
		t.Fatal("restore journal contains an absolute path")
	}
}
