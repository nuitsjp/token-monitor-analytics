package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type restoreValidationTestClock struct {
	now time.Time
}

func (c restoreValidationTestClock) Now() time.Time { return c.now }

type restoreValidationTestIDs struct {
	values []string
	index  int
}

func (g *restoreValidationTestIDs) New() string {
	value := g.values[g.index]
	g.index++
	return value
}

type restoreValidationTestArchive struct {
	directories []string
}

func (a *restoreValidationTestArchive) ValidateAndExtract(_ context.Context, _ string, root string, schemaVersion int64) (domain.BackupManifest, string, string, error) {
	directory, err := os.MkdirTemp(root, "restore-validated-*")
	if err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	a.directories = append(a.directories, directory)
	database := []byte("validated restore database")
	if err := os.WriteFile(filepath.Join(directory, "data.sqlite3"), database, 0o600); err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	databaseDigest := sha256.Sum256(database)
	artifactDigest := sha256.Sum256([]byte(directory))
	manifest := domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: schemaVersion,
		AppVersion:    "test",
		CreatedAt:     time.Date(2026, time.August, 26, 0, 0, 0, 0, time.UTC),
		Database: domain.BackupDatabaseManifest{
			Path:      "data.sqlite3",
			SizeBytes: int64(len(database)),
			SHA256:    hex.EncodeToString(databaseDigest[:]),
		},
	}
	return manifest, hex.EncodeToString(artifactDigest[:]), directory, nil
}

type restoreValidationTestDatabase struct {
	root         string
	trial        func(string, string, domain.BackupManifest) error
	validatePath string
	trialCalls   int
}

func (d *restoreValidationTestDatabase) ApplicationDataDirectory() (string, error) {
	return d.root, nil
}

func (d *restoreValidationTestDatabase) SchemaVersion() int64 { return 13 }

func (d *restoreValidationTestDatabase) ValidateRestoreDatabase(_ context.Context, path string, manifest domain.BackupManifest) error {
	d.validatePath = path
	if filepath.Base(path) != manifest.Database.Path {
		return errors.New("unexpected validated database path")
	}
	return nil
}

func (d *restoreValidationTestDatabase) RunIsolatedRestoreTrial(_ context.Context, source, trialDirectory string, manifest domain.BackupManifest) error {
	d.trialCalls++
	if d.trial != nil {
		return d.trial(source, trialDirectory, manifest)
	}
	return nil
}

type restoreValidationTestRecorder struct {
	states []domain.RestoreTrialState
}

func (r *restoreValidationTestRecorder) RecordRestoreTrial(_ context.Context, state domain.RestoreTrialState) error {
	r.states = append(r.states, state)
	return nil
}

func TestRestoreValidationUsecaseBindsOperationAndRecordsTrial(t *testing.T) {
	root := t.TempDir()
	database := &restoreValidationTestDatabase{root: root}
	archive := &restoreValidationTestArchive{}
	recorder := &restoreValidationTestRecorder{}
	testedAt := time.Date(2026, time.August, 26, 1, 2, 3, 0, time.UTC)
	usecase, err := NewRestoreValidationUsecase(database, archive, recorder, restoreValidationTestClock{now: testedAt}, &restoreValidationTestIDs{values: []string{"operation-one"}})
	if err != nil {
		t.Fatalf("new restore validation usecase: %v", err)
	}

	validation, err := usecase.ValidateArchive(context.Background(), filepath.Join(root, "artifact.zip"))
	if err != nil {
		t.Fatalf("validate archive: %v", err)
	}
	if validation.OperationID != "operation-one" || validation.ArtifactSHA256 == "" {
		t.Fatalf("unexpected validation result: %+v", validation)
	}
	if state := usecase.RestoreTrialState(); state.Status != domain.RestoreTrialNotRun || state.ArtifactSHA256 != validation.ArtifactSHA256 {
		t.Fatalf("unexpected initial trial state: %+v", state)
	}
	if _, err := usecase.RunRestoreTrial(context.Background(), database.validatePath); err == nil {
		t.Fatal("trial accepted a database path instead of the operation ID")
	}
	if database.trialCalls != 0 {
		t.Fatalf("trial ran for a rejected operation: %d", database.trialCalls)
	}

	state, err := usecase.RunRestoreTrial(context.Background(), validation.OperationID)
	if err != nil {
		t.Fatalf("run restore trial: %v", err)
	}
	if state.Status != domain.RestoreTrialPassed || !state.TestedAt.Equal(testedAt) || state.ArtifactSHA256 != validation.ArtifactSHA256 {
		t.Fatalf("unexpected passed state: %+v", state)
	}
	statuses := make([]domain.RestoreTrialStatus, 0, len(recorder.states))
	for _, recorded := range recorder.states {
		statuses = append(statuses, recorded.Status)
	}
	if want := []domain.RestoreTrialStatus{domain.RestoreTrialNotRun, domain.RestoreTrialRunning, domain.RestoreTrialPassed}; !reflect.DeepEqual(statuses, want) {
		t.Fatalf("recorded statuses = %v, want %v", statuses, want)
	}
	assertNoRestoreTrialDirectory(t, root)
	if err := usecase.Close(); err != nil {
		t.Fatalf("close restore validation usecase: %v", err)
	}
	if _, err := os.Stat(archive.directories[0]); !os.IsNotExist(err) {
		t.Fatalf("validated restore directory remains after close: %v", err)
	}
}

func TestRestoreValidationUsecaseInvalidatesPreviousOperation(t *testing.T) {
	root := t.TempDir()
	database := &restoreValidationTestDatabase{root: root}
	archive := &restoreValidationTestArchive{}
	usecase, err := NewRestoreValidationUsecase(database, archive, nil, restoreValidationTestClock{}, &restoreValidationTestIDs{values: []string{"operation-one", "operation-two"}})
	if err != nil {
		t.Fatalf("new restore validation usecase: %v", err)
	}
	first, err := usecase.ValidateArchive(context.Background(), "first.zip")
	if err != nil {
		t.Fatalf("validate first archive: %v", err)
	}
	second, err := usecase.ValidateArchive(context.Background(), "second.zip")
	if err != nil {
		t.Fatalf("validate second archive: %v", err)
	}
	if _, err := os.Stat(archive.directories[0]); !os.IsNotExist(err) {
		t.Fatalf("previous validated directory remains: %v", err)
	}
	if _, err := usecase.RunRestoreTrial(context.Background(), first.OperationID); err == nil {
		t.Fatal("previous restore operation remained usable")
	}
	if _, err := usecase.RunRestoreTrial(context.Background(), second.OperationID); err != nil {
		t.Fatalf("current restore operation was rejected: %v", err)
	}
}

func TestRestoreValidationUsecaseFailsWhenTrialCleanupFails(t *testing.T) {
	root := t.TempDir()
	database := &restoreValidationTestDatabase{root: root}
	database.trial = func(_ string, trialDirectory string, _ domain.BackupManifest) error {
		if err := os.Remove(trialDirectory); err != nil {
			return err
		}
		return os.WriteFile(trialDirectory, []byte("blocks managed directory cleanup"), 0o600)
	}
	archive := &restoreValidationTestArchive{}
	testedAt := time.Date(2026, time.August, 26, 4, 5, 6, 0, time.UTC)
	usecase, err := NewRestoreValidationUsecase(database, archive, nil, restoreValidationTestClock{now: testedAt}, &restoreValidationTestIDs{values: []string{"operation"}})
	if err != nil {
		t.Fatalf("new restore validation usecase: %v", err)
	}
	validation, err := usecase.ValidateArchive(context.Background(), "artifact.zip")
	if err != nil {
		t.Fatalf("validate archive: %v", err)
	}
	state, err := usecase.RunRestoreTrial(context.Background(), validation.OperationID)
	if err == nil {
		t.Fatal("cleanup failure was reported as a passed restore trial")
	}
	if state.Status != domain.RestoreTrialFailed || state.FailureCode != domain.RestoreValidationComparison || !state.TestedAt.Equal(testedAt) {
		t.Fatalf("unexpected cleanup failure state: %+v", state)
	}
}

func TestRemoveManagedRestoreDirectoryTreatsMissingDirectoryAsClean(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "restore-trial-missing")
	if err := removeManagedRestoreDirectory(root, directory, "restore-trial-"); err != nil {
		t.Fatalf("remove missing managed restore directory: %v", err)
	}
}

func assertNoRestoreTrialDirectory(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read restore workspace: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "restore-trial-") {
			t.Fatalf("restore trial path remains after cleanup: %s", entry.Name())
		}
	}
}
