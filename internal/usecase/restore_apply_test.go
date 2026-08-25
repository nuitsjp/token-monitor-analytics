package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type restoreApplyTestDatabase struct{ root string }

func (d restoreApplyTestDatabase) ApplicationDataDirectory() (string, error) { return d.root, nil }
func (restoreApplyTestDatabase) SchemaVersion() int64                        { return 13 }
func (restoreApplyTestDatabase) ValidateRestoreDatabase(context.Context, string, domain.BackupManifest) error {
	return nil
}
func (restoreApplyTestDatabase) RunIsolatedRestoreTrial(context.Context, string, string, domain.BackupManifest) error {
	return nil
}

type restoreApplyTestStore struct {
	path      string
	operation string
	result    domain.RestoreApplyResult
	err       error
}

func (s *restoreApplyTestStore) ApplyValidatedRestore(_ context.Context, path, operation, _ string, _ domain.BackupManifest, _ string, _ time.Time) (domain.RestoreApplyResult, error) {
	s.path, s.operation = path, operation
	return s.result, s.err
}

type restoreApplyTestCollection struct {
	wasRunning bool
	suspended  int
	resumed    int
}

func (c *restoreApplyTestCollection) Suspend(context.Context) (bool, error) {
	c.suspended++
	return c.wasRunning, nil
}
func (c *restoreApplyTestCollection) Resume(context.Context) error {
	c.resumed++
	return nil
}

func TestRestoreApplyAcceptsOnlyCurrentOperationIDAndConsumesIt(t *testing.T) {
	gate := NewMaintenanceGate()
	validation, candidate := restoreApplyValidationFixture(t, gate)
	store := &restoreApplyTestStore{result: domain.RestoreApplyResult{OperationID: "operation-one"}}
	collection := &restoreApplyTestCollection{wasRunning: true}
	usecase, err := NewRestoreApplyUsecase(validation, store, collection, restoreValidationTestClock{now: time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)}, &restoreValidationTestIDs{values: []string{"audit-one"}}, gate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := usecase.Apply(context.Background(), candidate, true); err == nil {
		t.Fatal("candidate path was accepted as an operation ID")
	}
	if _, err := usecase.Apply(context.Background(), "operation-one", false); err == nil {
		t.Fatal("unconfirmed restore was accepted")
	}
	if _, err := usecase.Apply(context.Background(), "operation-one", true); err != nil {
		t.Fatal(err)
	}
	if store.path != candidate || store.operation != "operation-one" {
		t.Fatalf("store received path=%q operation=%q", store.path, store.operation)
	}
	if collection.suspended != 1 || collection.resumed != 1 {
		t.Fatalf("collection suspend/resume = %d/%d", collection.suspended, collection.resumed)
	}
	if _, err := os.Lstat(filepath.Dir(candidate)); !os.IsNotExist(err) {
		t.Fatal("consumed validated candidate directory remains")
	}
	if _, err := usecase.Apply(context.Background(), "operation-one", true); err == nil {
		t.Fatal("consumed operation ID was accepted twice")
	}
}

func TestRestoreApplyResumesCollectionOnlyAfterSuccessfulRollback(t *testing.T) {
	gate := NewMaintenanceGate()
	validation, _ := restoreApplyValidationFixture(t, gate)
	store := &restoreApplyTestStore{result: domain.RestoreApplyResult{RollbackSucceeded: true}, err: errors.New("apply failed")}
	collection := &restoreApplyTestCollection{wasRunning: true}
	usecase, err := NewRestoreApplyUsecase(validation, store, collection, restoreValidationTestClock{now: time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)}, &restoreValidationTestIDs{values: []string{"audit-one"}}, gate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := usecase.Apply(context.Background(), "operation-one", true); err == nil {
		t.Fatal("restore failure was hidden")
	}
	if collection.resumed != 1 {
		t.Fatalf("collection resume count = %d, want 1", collection.resumed)
	}
}

func TestRestoreApplyUsesTheValidationMaintenanceGate(t *testing.T) {
	gate := NewMaintenanceGate()
	validation, _ := restoreApplyValidationFixture(t, gate)
	store := &restoreApplyTestStore{}
	collection := &restoreApplyTestCollection{}
	if _, err := NewRestoreApplyUsecase(validation, store, collection, restoreValidationTestClock{}, &restoreValidationTestIDs{}, NewMaintenanceGate()); err == nil {
		t.Fatal("different maintenance gates were accepted")
	}
	lease, err := gate.Acquire(context.Background(), MaintenanceBackup)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	usecase, err := NewRestoreApplyUsecase(validation, store, collection, restoreValidationTestClock{}, &restoreValidationTestIDs{}, gate)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := usecase.Apply(context.Background(), "operation-one", true); !errors.Is(err, ErrMaintenanceBusy) {
		t.Fatalf("competing restore error = %v, want busy", err)
	}
}

func restoreApplyValidationFixture(t *testing.T, gate *MaintenanceGate) (*RestoreValidationUsecase, string) {
	t.Helper()
	root := t.TempDir()
	directory, err := os.MkdirTemp(root, "restore-validated-")
	if err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(directory, "data.sqlite3")
	if err := os.WriteFile(candidate, []byte("candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	validation, err := NewRestoreValidationUsecase(restoreApplyTestDatabase{root: root}, &restoreValidationTestArchive{}, nil, restoreValidationTestClock{}, &restoreValidationTestIDs{}, gate)
	if err != nil {
		t.Fatal(err)
	}
	validation.current = &validatedRestore{
		operationID: "operation-one", artifactSHA256: repeatRestoreApplyHex("a"),
		manifest:  domain.BackupManifest{FormatVersion: 1, SchemaVersion: 13},
		directory: directory, databasePath: candidate,
	}
	return validation, candidate
}

func repeatRestoreApplyHex(value string) string {
	result := ""
	for range 64 {
		result += value
	}
	return result
}
