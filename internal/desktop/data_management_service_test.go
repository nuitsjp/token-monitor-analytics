package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type dataManagementPurgeFake struct {
	capacity       domain.DataCapacity
	capacityErr    error
	preview        domain.PurgePreview
	previewErr     error
	previewFunc    func(context.Context, domain.PurgeSelection) (domain.PurgePreview, error)
	result         domain.PurgeResult
	purgeErr       error
	previewInput   domain.PurgeSelection
	purgeInput     domain.PurgeSelection
	purgeConfirmed bool
	purgeCalls     int
}

func (f *dataManagementPurgeFake) Capacity(context.Context) (domain.DataCapacity, error) {
	return f.capacity, f.capacityErr
}

func (f *dataManagementPurgeFake) Preview(ctx context.Context, selection domain.PurgeSelection) (domain.PurgePreview, error) {
	normalized, err := selection.Normalized()
	if err != nil {
		return domain.PurgePreview{}, err
	}
	f.previewInput = normalized
	if f.previewFunc != nil {
		return f.previewFunc(ctx, normalized)
	}
	if f.preview.Selection.HubIDs == nil && !f.preview.Selection.AllHubs {
		f.preview.Selection = normalized
	}
	return f.preview, f.previewErr
}

func (f *dataManagementPurgeFake) Purge(_ context.Context, selection domain.PurgeSelection, confirmed bool) (domain.PurgeResult, error) {
	f.purgeCalls++
	f.purgeConfirmed = confirmed
	if !confirmed {
		return domain.PurgeResult{}, errors.New("purge confirmation is required")
	}
	normalized, err := selection.Normalized()
	if err != nil {
		return domain.PurgeResult{}, err
	}
	f.purgeInput = normalized
	return f.result, f.purgeErr
}

type dataManagementBackupFake struct {
	artifact domain.BackupArtifact
	err      error
	fn       func(context.Context, string, usecase.BackupProgressReporter) (domain.BackupArtifact, error)
	path     string
}

func (f *dataManagementBackupFake) CreateBackup(ctx context.Context, path string, reporter usecase.BackupProgressReporter) (domain.BackupArtifact, error) {
	f.path = path
	if f.fn != nil {
		return f.fn(ctx, path, reporter)
	}
	return f.artifact, f.err
}

type dataManagementValidationFake struct {
	mu             sync.Mutex
	validation     domain.RestoreValidationResult
	validationErr  error
	validationFunc func(context.Context, string) (domain.RestoreValidationResult, error)
	trial          domain.RestoreTrialState
	trialErr       error
	trialFunc      func(context.Context, string) (domain.RestoreTrialState, error)
	archivePath    string
	trialOperation string
}

func (f *dataManagementValidationFake) ValidateArchive(ctx context.Context, path string) (domain.RestoreValidationResult, error) {
	f.mu.Lock()
	f.archivePath = path
	fn := f.validationFunc
	result := f.validation
	err := f.validationErr
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, path)
	}
	return result, err
}

func (f *dataManagementValidationFake) RunRestoreTrial(ctx context.Context, operationID string) (domain.RestoreTrialState, error) {
	f.mu.Lock()
	f.trialOperation = operationID
	fn := f.trialFunc
	result := f.trial
	err := f.trialErr
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, operationID)
	}
	return result, err
}

func (f *dataManagementValidationFake) RestoreTrialState() domain.RestoreTrialState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.trial
}

func (f *dataManagementValidationFake) setTrial(state domain.RestoreTrialState) {
	f.mu.Lock()
	f.trial = state
	f.mu.Unlock()
}

type dataManagementApplyFake struct {
	result      domain.RestoreApplyResult
	err         error
	fn          func(context.Context, string, bool) (domain.RestoreApplyResult, error)
	operationID string
	confirmed   bool
	calls       int
}

func (f *dataManagementApplyFake) Apply(ctx context.Context, operationID string, confirmed bool) (domain.RestoreApplyResult, error) {
	f.calls++
	f.operationID = operationID
	f.confirmed = confirmed
	if !confirmed {
		return domain.RestoreApplyResult{}, errors.New("restore confirmation is required")
	}
	if f.fn != nil {
		return f.fn(ctx, operationID, confirmed)
	}
	return f.result, f.err
}

func newDataManagementServiceForTest(
	t *testing.T,
	purge *dataManagementPurgeFake,
	backup *dataManagementBackupFake,
	validation *dataManagementValidationFake,
	apply *dataManagementApplyFake,
	gate *usecase.MaintenanceGate,
	recovery domain.RestoreRecoveryResult,
) *DataManagementService {
	t.Helper()
	service, err := NewDataManagementServiceWithDependencies(purge, backup, validation, apply, gate, recovery, "1.2.3", 13)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestNewDataManagementServiceRequiresDependenciesAndKnownVersions(t *testing.T) {
	purge := &dataManagementPurgeFake{}
	backup := &dataManagementBackupFake{}
	validation := &dataManagementValidationFake{}
	apply := &dataManagementApplyFake{}
	gate := usecase.NewMaintenanceGate()
	tests := []struct {
		name       string
		purge      dataManagementPurgeUsecase
		backup     dataManagementBackupUsecase
		validation dataManagementRestoreValidationUsecase
		apply      dataManagementRestoreApplyUsecase
		gate       *usecase.MaintenanceGate
		version    string
		schema     int64
		recovery   domain.RestoreRecoveryStatus
	}{
		{name: "purge", backup: backup, validation: validation, apply: apply, gate: gate, version: "1", schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "backup", purge: purge, validation: validation, apply: apply, gate: gate, version: "1", schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "validation", purge: purge, backup: backup, apply: apply, gate: gate, version: "1", schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "apply", purge: purge, backup: backup, validation: validation, gate: gate, version: "1", schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "gate", purge: purge, backup: backup, validation: validation, apply: apply, version: "1", schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "version", purge: purge, backup: backup, validation: validation, apply: apply, gate: gate, schema: 1, recovery: domain.RestoreRecoveryNone},
		{name: "schema", purge: purge, backup: backup, validation: validation, apply: apply, gate: gate, version: "1", recovery: domain.RestoreRecoveryNone},
		{name: "recovery", purge: purge, backup: backup, validation: validation, apply: apply, gate: gate, version: "1", schema: 1, recovery: "future"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewDataManagementServiceWithDependencies(test.purge, test.backup, test.validation, test.apply, test.gate, domain.RestoreRecoveryResult{Status: test.recovery}, test.version, test.schema); err == nil {
				t.Fatal("invalid constructor input was accepted")
			}
		})
	}
}

func TestDataManagementStateMapsCapacityBackupRecoveryAndMaintenance(t *testing.T) {
	oldest := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	latest := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	purge := &dataManagementPurgeFake{capacity: domain.DataCapacity{
		DatabaseSizeBytes: 4096, RawSnapshotCount: 7, OldestCompletedAt: &oldest,
		LatestCompletedAt: &latest, RawJSONBytes: 1024,
	}}
	artifactTime := latest.Add(time.Minute)
	backup := &dataManagementBackupFake{artifact: domain.BackupArtifact{
		Path: `D:\backups\token-monitor.zip`, SizeBytes: 8192,
		ArtifactSHA256: strings.Repeat("a", 64), CreatedAt: artifactTime, Warning: "backup result record failed",
	}}
	validation := &dataManagementValidationFake{trial: domain.RestoreTrialState{Status: domain.RestoreTrialNotRun}}
	apply := &dataManagementApplyFake{}
	gate := usecase.NewMaintenanceGate()
	service := newDataManagementServiceForTest(t, purge, backup, validation, apply, gate, domain.RestoreRecoveryResult{
		Status: domain.RestoreRecoveryRolledBack, ArtifactSHA256: strings.Repeat("b", 64),
	})

	created := service.CreateBackup(context.Background(), `D:\backups\token-monitor.zip`)
	if created.Status != "success" || created.Artifact == nil {
		t.Fatalf("backup state = %#v", created)
	}
	if created.Artifact.Path != `D:\backups\token-monitor.zip` || created.Artifact.SizeBytes != 8192 || created.Artifact.FormatVersion != domain.BackupFormatVersion || created.Artifact.SchemaVersion != 13 || created.Artifact.AppVersion != "1.2.3" || created.Artifact.CreatedAt != artifactTime.Format(time.RFC3339Nano) {
		t.Fatalf("backup artifact = %#v", created.Artifact)
	}
	state := service.GetState(context.Background())
	if state.Capacity.Status != "success" || state.Capacity.Capacity == nil || state.Capacity.Capacity.RawSnapshotCount != 7 || state.Capacity.Capacity.RawJSONBytes != 1024 || state.Capacity.Capacity.OldestCompletedAt != oldest.Format(time.RFC3339Nano) {
		t.Fatalf("capacity = %#v", state.Capacity)
	}
	if state.Recovery.Status != string(domain.RestoreRecoveryRolledBack) || state.Recovery.ArtifactSHA256 != strings.Repeat("b", 64) || !strings.Contains(state.Recovery.Message, "元のデータベース") {
		t.Fatalf("recovery = %#v", state.Recovery)
	}
	lease, err := gate.Acquire(context.Background(), usecase.MaintenanceEdit)
	if err != nil {
		t.Fatal(err)
	}
	maintenance := service.GetMaintenanceState()
	lease.Release()
	if !maintenance.Active || maintenance.Operation != string(usecase.MaintenanceEdit) || maintenance.CancelAllowed {
		t.Fatalf("maintenance = %#v", maintenance)
	}
}

func TestDataManagementPurgePreservesHalfOpenSelectionConfirmationAndRollback(t *testing.T) {
	start := "2026-08-01T09:00:00+09:00"
	end := "2026-09-01T09:00:00+09:00"
	previewCapacity := domain.DataCapacity{RawSnapshotCount: 4, RawJSONBytes: 500}
	purge := &dataManagementPurgeFake{preview: domain.PurgePreview{Capacity: previewCapacity}}
	service := newDataManagementServiceForTest(t, purge, &dataManagementBackupFake{}, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	input := DataManagementPurgeSelectionInput{HubIDs: []string{"hub-b", "hub-a"}, StartAt: start, EndAt: end}

	preview := service.PreviewPurge(context.Background(), input)
	if preview.Status != "ready" || preview.Preview == nil || preview.Preview.Capacity.RawSnapshotCount != 4 {
		t.Fatalf("preview = %#v", preview)
	}
	if strings.Join(purge.previewInput.HubIDs, ",") != "hub-a,hub-b" || purge.previewInput.Start == nil || purge.previewInput.Start.Format(time.RFC3339) != "2026-08-01T00:00:00Z" || purge.previewInput.End == nil || purge.previewInput.End.Format(time.RFC3339) != "2026-09-01T00:00:00Z" {
		t.Fatalf("normalized selection = %#v", purge.previewInput)
	}
	if preview.Preview.Selection.StartAt != "2026-08-01T00:00:00Z" || preview.Preview.Selection.EndAt != "2026-09-01T00:00:00Z" {
		t.Fatalf("preview UTC selection = %#v", preview.Preview.Selection)
	}

	notConfirmed := service.ApplyPurge(context.Background(), input, false)
	if notConfirmed.Error == nil || notConfirmed.Error.Code != "purge_confirmation_required" || purge.purgeCalls != 1 || purge.purgeConfirmed {
		t.Fatalf("unconfirmed purge = %#v, calls=%d", notConfirmed, purge.purgeCalls)
	}
	purge.purgeErr = errors.New("database raw failure at C:\\private\\data.sqlite3")
	failed := service.ApplyPurge(context.Background(), input, true)
	if failed.Error == nil || failed.Error.Code != "purge_failed_rolled_back" || !failed.Error.RolledBack || !failed.Error.CurrentDataUnchanged || !purge.purgeConfirmed {
		t.Fatalf("failed purge = %#v", failed)
	}
	encoded, err := json.Marshal(failed)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "raw failure") {
		t.Fatalf("raw purge error crossed desktop boundary: %s", encoded)
	}
}

func TestDataManagementFullPurgeRequiresExactDisplayedConfirmationText(t *testing.T) {
	purge := &dataManagementPurgeFake{preview: domain.PurgePreview{
		Selection: domain.PurgeSelection{AllHubs: true},
		Capacity:  domain.DataCapacity{RawSnapshotCount: 10, RawJSONBytes: 2048},
	}, result: domain.PurgeResult{AuditID: "purge-audit", ExecutedAt: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}}
	service := newDataManagementServiceForTest(t, purge, &dataManagementBackupFake{}, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	preview := service.PreviewPurge(context.Background(), DataManagementPurgeSelectionInput{AllHubs: true})
	if preview.Preview == nil || preview.Preview.RequiredConfirmationText != DataManagementFullPurgeConfirmationText {
		t.Fatalf("full purge preview = %#v", preview)
	}
	wrong := service.ApplyPurge(context.Background(), DataManagementPurgeSelectionInput{AllHubs: true, ConfirmationText: DataManagementFullPurgeConfirmationText + " "}, true)
	if wrong.Error == nil || wrong.Error.Code != "purge_confirmation_text_required" || purge.purgeCalls != 0 {
		t.Fatalf("wrong full purge confirmation = %#v, calls=%d", wrong, purge.purgeCalls)
	}
	succeeded := service.ApplyPurge(context.Background(), DataManagementPurgeSelectionInput{AllHubs: true, ConfirmationText: DataManagementFullPurgeConfirmationText}, true)
	if succeeded.Status != "success" || succeeded.Result == nil || succeeded.Result.AuditID != "purge-audit" || purge.purgeCalls != 1 {
		t.Fatalf("confirmed full purge = %#v, calls=%d", succeeded, purge.purgeCalls)
	}
}

func TestDataManagementPreviewCanBeCanceledThroughExplicitBoundary(t *testing.T) {
	started := make(chan struct{})
	purge := &dataManagementPurgeFake{previewFunc: func(ctx context.Context, selection domain.PurgeSelection) (domain.PurgePreview, error) {
		close(started)
		<-ctx.Done()
		return domain.PurgePreview{}, ctx.Err()
	}}
	service := newDataManagementServiceForTest(t, purge, &dataManagementBackupFake{}, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	result := make(chan DataManagementPurgeStateSnapshot, 1)
	go func() {
		result <- service.PreviewPurge(context.Background(), DataManagementPurgeSelectionInput{AllHubs: true})
	}()
	<-started
	maintenance := service.GetMaintenanceState()
	if maintenance.Phase != "purge_preview" || !maintenance.CancelAllowed || maintenance.Operation != string(usecase.MaintenancePurge) {
		t.Fatalf("preview maintenance = %#v", maintenance)
	}
	canceled := service.CancelCurrentOperation()
	if canceled.Status != "cancellation_requested" || canceled.Phase != "purge_preview" || canceled.CancelAllowed {
		t.Fatalf("cancel response = %#v", canceled)
	}
	finished := <-result
	if finished.Error == nil || finished.Error.Code != "operation_canceled" || finished.Status != "failed" {
		t.Fatalf("canceled preview = %#v", finished)
	}
	if service.GetMaintenanceState().Active {
		t.Fatal("maintenance remained active after canceled preview")
	}
}

func TestDataManagementRestoreValidationAndTrialExposeTypedStatesAndCancellation(t *testing.T) {
	createdAt := time.Date(2026, 8, 25, 10, 30, 0, 0, time.UTC)
	validation := &dataManagementValidationFake{
		validation: domain.RestoreValidationResult{
			OperationID: "opaque-validation-id", ArtifactSHA256: strings.Repeat("c", 64),
			FormatVersion: 1, SchemaVersion: 13, ArtifactCreatedAt: createdAt,
		},
		trial: domain.RestoreTrialState{Status: domain.RestoreTrialNotRun},
	}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, &dataManagementBackupFake{}, validation, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})

	validated := service.ValidateRestore(context.Background(), `D:\incoming\backup.zip`)
	if validated.Status != "success" || !validated.ApplyAllowed || validated.OperationID != "opaque-validation-id" || validated.Artifact == nil || validated.Artifact.ArtifactSHA256 != strings.Repeat("c", 64) {
		t.Fatalf("validation = %#v", validated)
	}
	if validated.Artifact.Path != "" || validated.Artifact.SizeBytes != 0 || validated.Artifact.AppVersion != "" || validated.Artifact.CreatedAt != createdAt.Format(time.RFC3339Nano) {
		t.Fatalf("restore artifact contains guessed metadata: %#v", validated.Artifact)
	}
	validation.validationErr = &domain.RestoreValidationError{Code: domain.RestoreValidationManifestBOM, Err: errors.New("raw parser detail")}
	failedValidation := service.ValidateRestore(context.Background(), `D:\incoming\bad.zip`)
	if failedValidation.Error == nil || failedValidation.Error.Code != "restore_validation_manifest_bom" || !failedValidation.Error.CurrentDataUnchanged || strings.Contains(failedValidation.Error.Message, "raw parser") {
		t.Fatalf("failed validation = %#v", failedValidation)
	}

	trialStarted := make(chan struct{})
	validation.trialFunc = func(ctx context.Context, operationID string) (domain.RestoreTrialState, error) {
		state := domain.RestoreTrialState{Status: domain.RestoreTrialRunning, ArtifactSHA256: strings.Repeat("c", 64)}
		validation.setTrial(state)
		close(trialStarted)
		<-ctx.Done()
		failed := domain.RestoreTrialState{Status: domain.RestoreTrialFailed, ArtifactSHA256: strings.Repeat("c", 64), TestedAt: createdAt, FailureCode: domain.RestoreValidationComparison}
		validation.setTrial(failed)
		return failed, ctx.Err()
	}
	trialResult := make(chan DataManagementRestoreTrialStateSnapshot, 1)
	go func() { trialResult <- service.RunRestoreTrial(context.Background(), "opaque-validation-id") }()
	<-trialStarted
	inProgress := service.GetRestoreState().Trial
	if inProgress.Status != string(domain.RestoreTrialRunning) || !inProgress.CancelAllowed {
		t.Fatalf("running trial = %#v", inProgress)
	}
	if canceled := service.CancelCurrentOperation(); canceled.Status != "cancellation_requested" || canceled.Phase != "restore_trial" {
		t.Fatalf("trial cancel = %#v", canceled)
	}
	if service.GetRestoreState().Trial.CancelAllowed {
		t.Fatal("trial remained cancelable after cancellation was requested")
	}
	finished := <-trialResult
	if finished.Status != string(domain.RestoreTrialFailed) || finished.Error == nil || finished.Error.Code != "operation_canceled" || validation.trialOperation != "opaque-validation-id" {
		t.Fatalf("canceled trial = %#v", finished)
	}
}

func TestDataManagementRestoreValidationCanBeCanceledThroughExplicitBoundary(t *testing.T) {
	started := make(chan struct{})
	validation := &dataManagementValidationFake{trial: domain.RestoreTrialState{Status: domain.RestoreTrialNotRun}}
	validation.validationFunc = func(ctx context.Context, path string) (domain.RestoreValidationResult, error) {
		close(started)
		<-ctx.Done()
		return domain.RestoreValidationResult{}, ctx.Err()
	}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, &dataManagementBackupFake{}, validation, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	result := make(chan DataManagementRestoreValidationStateSnapshot, 1)
	go func() { result <- service.ValidateRestore(context.Background(), `D:\incoming\backup.zip`) }()
	<-started
	inProgress := service.GetRestoreState().Validation
	if inProgress.Status != "validating" || !inProgress.CancelAllowed {
		t.Fatalf("validating restore = %#v", inProgress)
	}
	canceled := service.CancelCurrentOperation()
	if canceled.Status != "cancellation_requested" || canceled.Phase != "restore_validation" || canceled.CancellationBoundary != "until_operation_finishes" {
		t.Fatalf("restore validation cancellation = %#v", canceled)
	}
	finished := <-result
	if finished.Status != "failed" || finished.Error == nil || finished.Error.Code != "operation_canceled" || !finished.Error.CurrentDataUnchanged {
		t.Fatalf("canceled restore validation = %#v", finished)
	}
}

func TestDataManagementRestoreApplyCancellationRequestIsIgnoredAfterAtomicBoundaryAndSuccessDoesNotReportRollback(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	restoredAt := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	apply := &dataManagementApplyFake{fn: func(_ context.Context, operationID string, confirmed bool) (domain.RestoreApplyResult, error) {
		close(started)
		<-release
		return domain.RestoreApplyResult{
			OperationID: operationID, ArtifactSHA256: strings.Repeat("d", 64), FormatVersion: 1,
			SchemaVersion: 13, RestoredAt: restoredAt, AuditID: "restore-audit", RollbackSucceeded: true,
			Warning: "collection scheduler restart failed",
		}, nil
	}}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, &dataManagementBackupFake{}, &dataManagementValidationFake{}, apply, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	result := make(chan DataManagementRestoreApplyStateSnapshot, 1)
	go func() { result <- service.ApplyRestore(context.Background(), "opaque-validation-id", true) }()
	<-started
	maintenance := service.GetMaintenanceState()
	if maintenance.Phase != "restore_apply" || !maintenance.CancelAllowed || maintenance.CancellationBoundary != "before_atomic_replace_only" {
		t.Fatalf("restore apply maintenance = %#v", maintenance)
	}
	requested := service.CancelCurrentOperation()
	if requested.Status != "cancellation_requested" || requested.CancellationBoundary != "before_atomic_replace_only" || !strings.Contains(requested.Message, "入替え開始後") {
		t.Fatalf("restore apply cancellation = %#v", requested)
	}
	close(release)
	succeeded := <-result
	if succeeded.Status != "success" || succeeded.CancelAllowed || succeeded.CredentialState != string(domain.CredentialPostRestorePending) || !succeeded.RequiresCredentialReregistration || succeeded.Artifact == nil || succeeded.RestoredAt != restoredAt.Format(time.RFC3339Nano) || succeeded.AuditID != "restore-audit" || succeeded.RollbackSucceeded {
		t.Fatalf("restore apply success = %#v", succeeded)
	}
	if validationState := service.GetRestoreState().Validation; validationState.ApplyAllowed || validationState.OperationID != "" {
		t.Fatalf("consumed validation remained applicable: %#v", validationState)
	}
	if !apply.confirmed || apply.operationID != "opaque-validation-id" {
		t.Fatalf("restore apply input = confirmed %t operation %q", apply.confirmed, apply.operationID)
	}

	apply.fn = nil
	apply.result = domain.RestoreApplyResult{OperationID: "opaque-validation-id", ArtifactSHA256: strings.Repeat("d", 64), RollbackSucceeded: true}
	apply.err = errors.New("raw restore failure C:\\private\\candidate.sqlite3")
	failed := service.ApplyRestore(context.Background(), "opaque-validation-id", true)
	if failed.Error == nil || failed.Error.Code != "restore_failed_rolled_back" || !failed.Error.RolledBack || !failed.Error.CurrentDataUnchanged || !failed.RollbackSucceeded {
		t.Fatalf("restore rollback = %#v", failed)
	}
	encoded, err := json.Marshal(failed)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "candidate.sqlite3") || strings.Contains(string(encoded), "raw restore") {
		t.Fatalf("raw restore error crossed desktop boundary: %s", encoded)
	}
}

func TestDataManagementRestoreApplyCancelReachesUsecaseBeforeAtomicBoundary(t *testing.T) {
	started := make(chan struct{})
	apply := &dataManagementApplyFake{fn: func(ctx context.Context, operationID string, confirmed bool) (domain.RestoreApplyResult, error) {
		close(started)
		<-ctx.Done()
		return domain.RestoreApplyResult{OperationID: operationID, RollbackSucceeded: true}, ctx.Err()
	}}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, &dataManagementBackupFake{}, &dataManagementValidationFake{}, apply, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	result := make(chan DataManagementRestoreApplyStateSnapshot, 1)
	go func() { result <- service.ApplyRestore(context.Background(), "opaque-validation-id", true) }()
	<-started
	if canceled := service.CancelCurrentOperation(); canceled.Status != "cancellation_requested" || canceled.Phase != "restore_apply" {
		t.Fatalf("restore precommit cancellation = %#v", canceled)
	}
	finished := <-result
	if finished.Status != "failed" || finished.Error == nil || finished.Error.Code != "restore_canceled_before_replace" || !finished.RollbackSucceeded || !finished.Error.CurrentDataUnchanged {
		t.Fatalf("canceled restore apply = %#v", finished)
	}
}

func TestDataManagementBackupFailureDoesNotExposeRawErrorOrSecret(t *testing.T) {
	backup := &dataManagementBackupFake{err: errors.New(`open D:\secret\password-token.zip: sentinel-secret`)}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, backup, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	failed := service.CreateBackup(context.Background(), `D:\backup\target.zip`)
	if failed.Error == nil || failed.Error.Code != "backup_failed" || !failed.Error.CurrentDataUnchanged {
		t.Fatalf("backup failure = %#v", failed)
	}
	encoded, err := json.Marshal(failed)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"password-token", "sentinel-secret", `D:\\secret`} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("backup error contains %q: %s", forbidden, encoded)
		}
	}
}

func TestDataManagementBackupReportsCreatingThenValidatingButRejectsCancellation(t *testing.T) {
	reported := make(chan usecase.BackupProgress)
	release := make(chan struct{})
	backup := &dataManagementBackupFake{fn: func(_ context.Context, _ string, reporter usecase.BackupProgressReporter) (domain.BackupArtifact, error) {
		for _, progress := range []usecase.BackupProgress{
			usecase.BackupProgressCreating,
			usecase.BackupProgressValidating,
			usecase.BackupProgressCreating,
			usecase.BackupProgressValidating,
		} {
			reporter(progress)
			reported <- progress
			<-release
		}
		return domain.BackupArtifact{Path: `D:\backup\target.zip`, ArtifactSHA256: strings.Repeat("e", 64), SizeBytes: 1, CreatedAt: time.Now().UTC()}, nil
	}}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, backup, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	result := make(chan DataManagementBackupStateSnapshot, 1)
	go func() { result <- service.CreateBackup(context.Background(), `D:\backup\target.zip`) }()
	want := []usecase.BackupProgress{
		usecase.BackupProgressCreating,
		usecase.BackupProgressValidating,
		usecase.BackupProgressCreating,
		usecase.BackupProgressValidating,
	}
	for index, expected := range want {
		if actual := <-reported; actual != expected {
			t.Fatalf("reported progress[%d] = %q, want %q", index, actual, expected)
		}
		state := service.GetState(context.Background())
		if state.Backup.Status != string(expected) || state.Maintenance.Phase != "backup_create" || state.Maintenance.CancelAllowed {
			t.Fatalf("backup state at progress[%d] = %#v", index, state)
		}
		if index == 0 {
			if canceled := service.CancelCurrentOperation(); canceled.Error == nil || canceled.Error.Code != "operation_not_cancelable" {
				t.Fatalf("backup cancellation = %#v", canceled)
			}
		}
		release <- struct{}{}
	}
	if completed := <-result; completed.Status != "success" {
		t.Fatalf("completed backup = %#v", completed)
	}
}

func TestDataManagementBackupValidationFailureEndsInFailedState(t *testing.T) {
	backup := &dataManagementBackupFake{fn: func(_ context.Context, _ string, reporter usecase.BackupProgressReporter) (domain.BackupArtifact, error) {
		reporter(usecase.BackupProgressCreating)
		reporter(usecase.BackupProgressValidating)
		return domain.BackupArtifact{}, errors.New("validation failed with private path")
	}}
	service := newDataManagementServiceForTest(t, &dataManagementPurgeFake{}, backup, &dataManagementValidationFake{}, &dataManagementApplyFake{}, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	failed := service.CreateBackup(context.Background(), `D:\backup\target.zip`)
	if failed.Status != "failed" || failed.Error == nil || failed.Error.Code != "backup_failed" {
		t.Fatalf("failed backup validation state = %#v", failed)
	}
}

func TestDataManagementRestoreValidationErrorCodesAreExhaustive(t *testing.T) {
	codes := []domain.RestoreValidationCode{
		domain.RestoreValidationArchive, domain.RestoreValidationZIPEntry, domain.RestoreValidationZIPCRC,
		domain.RestoreValidationManifestBOM, domain.RestoreValidationManifestJSON, domain.RestoreValidationManifestKey,
		domain.RestoreValidationFormatVersion, domain.RestoreValidationSchemaVersion, domain.RestoreValidationDeclaredSize,
		domain.RestoreValidationFreeSpace, domain.RestoreValidationDatabaseSHA, domain.RestoreValidationIntegrity,
		domain.RestoreValidationRequiredSchema, domain.RestoreValidationEnum, domain.RestoreValidationDatetime,
		domain.RestoreValidationForeignKey, domain.RestoreValidationInterval, domain.RestoreValidationSecret,
		domain.RestoreValidationRecalculation, domain.RestoreValidationComparison,
	}
	for _, code := range codes {
		t.Run(string(code), func(t *testing.T) {
			mapped := restoreValidationErrorSnapshot(code)
			if mapped.Code != "restore_validation_"+string(code) || mapped.Message == "" || len(mapped.Details) != 1 || !mapped.CurrentDataUnchanged {
				t.Fatalf("mapped validation error = %#v", mapped)
			}
		})
	}
}

func TestDataManagementInvalidInputAndIdleCancelAreSafe(t *testing.T) {
	purge := &dataManagementPurgeFake{}
	apply := &dataManagementApplyFake{}
	service := newDataManagementServiceForTest(t, purge, &dataManagementBackupFake{}, &dataManagementValidationFake{}, apply, usecase.NewMaintenanceGate(), domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	invalid := service.PreviewPurge(context.Background(), DataManagementPurgeSelectionInput{AllHubs: true, StartAt: "not-a-time"})
	if invalid.Error == nil || invalid.Error.Code != "purge_selection_invalid" {
		t.Fatalf("invalid purge input = %#v", invalid)
	}
	unconfirmed := service.ApplyRestore(context.Background(), "operation", false)
	if unconfirmed.Error == nil || unconfirmed.Error.Code != "restore_confirmation_required" || apply.calls != 1 || apply.confirmed {
		t.Fatalf("unconfirmed restore = %#v, calls=%d", unconfirmed, apply.calls)
	}
	idle := service.CancelCurrentOperation()
	if idle.Error == nil || idle.Error.Code != "operation_not_running" {
		t.Fatalf("idle cancel = %#v", idle)
	}
}
