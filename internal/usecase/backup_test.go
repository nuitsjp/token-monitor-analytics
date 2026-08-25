package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"token-monitor-analytics/internal/adapter/backupzip"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

type backupTestClock struct{}

func (backupTestClock) Now() time.Time {
	return time.Date(2026, 8, 26, 3, 4, 5, 6, time.UTC)
}

type backupTestReplacer struct{}

func (backupTestReplacer) Replace(sourcePath, destinationPath string) error {
	return os.Rename(sourcePath, destinationPath)
}

type backupTestRecorder struct {
	err       error
	artifacts []domain.BackupArtifact
}

func (r *backupTestRecorder) RecordBackup(_ context.Context, artifact domain.BackupArtifact) error {
	r.artifacts = append(r.artifacts, artifact)
	return r.err
}

func TestBackupUsecaseCreatesOnlineBackupAndRecordsArtifact(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	exportDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(exportDir, 0o700); err != nil {
		t.Fatalf("create export directory: %v", err)
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(dataDir, "analytics.sqlite3")); err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	writer, err := backupzip.NewWriterWithAtomicReplacer(backupTestReplacer{})
	if err != nil {
		t.Fatalf("create backup writer: %v", err)
	}
	recorder := &backupTestRecorder{}
	usecase, err := NewBackupUsecase(lifecycle, writer, recorder, backupTestClock{}, "0.1.0")
	if err != nil {
		t.Fatalf("create backup usecase: %v", err)
	}
	destination := filepath.Join(exportDir, "analytics-backup.zip")
	artifact, err := usecase.CreateBackup(ctx, destination)
	if err != nil {
		t.Fatalf("create backup: %v", err)
	}
	if artifact.Path != destination || artifact.ArtifactSHA256 == "" || artifact.Warning != "" {
		t.Fatalf("artifact = %#v", artifact)
	}
	if len(recorder.artifacts) != 1 || recorder.artifacts[0].ArtifactSHA256 != artifact.ArtifactSHA256 {
		t.Fatalf("recorded artifacts = %#v", recorder.artifacts)
	}
}

func TestBackupUsecaseRejectsSecretRawSnapshotBeforeCommit(t *testing.T) {
	assertBackupRejectsRawSnapshot(t, []byte(`{"devices":[{"accessToken":"secret-sentinel"}]}`))
}

func TestBackupUsecaseRejectsUnknownRawSnapshotBeforeCommit(t *testing.T) {
	assertBackupRejectsRawSnapshot(t, []byte(`{"devices":[{"unknownField":"unknown-sentinel"}]}`))
}

func assertBackupRejectsRawSnapshot(t *testing.T, raw []byte) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	exportDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(exportDir, 0o700); err != nil {
		t.Fatalf("create export directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "analytics.sqlite3")
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, databasePath); err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatalf("get database: %v", err)
	}
	now := "2026-08-26T03:04:05Z"
	if _, err := database.Exec(`
		INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at)
		VALUES ('hub-1', 'Hub', 'https://hub.example.test', 0, 300, ?, ?);`, now, now); err != nil {
		t.Fatalf("insert Hub: %v", err)
	}
	if _, err := database.Exec(`
		INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds)
		VALUES ('attempt-1', 'hub-1', 'manual', 'succeeded', ?, 300);`, now); err != nil {
		t.Fatalf("insert collection attempt: %v", err)
	}
	if _, err := database.Exec(`
		INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body)
		VALUES ('snapshot-1', 'attempt-1', 'hub-1', 'stats', ?, ?, 200, ?);`, now, now,
		raw); err != nil {
		t.Fatalf("insert raw snapshot: %v", err)
	}
	writer, err := backupzip.NewWriterWithAtomicReplacer(backupTestReplacer{})
	if err != nil {
		t.Fatalf("create backup writer: %v", err)
	}
	usecase, err := NewBackupUsecase(lifecycle, writer, nil, backupTestClock{}, "0.1.0")
	if err != nil {
		t.Fatalf("create backup usecase: %v", err)
	}
	destination := filepath.Join(exportDir, "analytics-backup.zip")
	before := []byte("existing artifact")
	if err := os.WriteFile(destination, before, 0o600); err != nil {
		t.Fatalf("write existing artifact: %v", err)
	}
	if _, err := usecase.CreateBackup(ctx, destination); err == nil {
		t.Fatal("forbidden raw snapshot unexpectedly accepted")
	}
	after, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("read existing artifact: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("existing artifact changed from %q to %q", before, after)
	}
}

func TestBackupUsecaseReturnsSuccessWarningWhenRecorderFails(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	exportDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(exportDir, 0o700); err != nil {
		t.Fatalf("create export directory: %v", err)
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(dataDir, "analytics.sqlite3")); err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	writer, err := backupzip.NewWriterWithAtomicReplacer(backupTestReplacer{})
	if err != nil {
		t.Fatalf("create backup writer: %v", err)
	}
	recorder := &backupTestRecorder{err: errors.New("database record failed")}
	usecase, err := NewBackupUsecase(lifecycle, writer, recorder, backupTestClock{}, "0.1.0")
	if err != nil {
		t.Fatalf("create backup usecase: %v", err)
	}
	artifact, err := usecase.CreateBackup(ctx, filepath.Join(exportDir, "analytics-backup.zip"))
	if err != nil {
		t.Fatalf("create backup: %v", err)
	}
	if artifact.Warning != "backup result record failed" {
		t.Fatalf("warning = %q", artifact.Warning)
	}
	if filepath.IsAbs(artifact.Warning) {
		t.Fatal("warning exposes an absolute path")
	}
}
