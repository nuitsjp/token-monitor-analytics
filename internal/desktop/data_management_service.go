package desktop

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

const DataManagementFullPurgeConfirmationText = "すべてのHubの全期間データをパージする"

type dataManagementPurgeUsecase interface {
	Capacity(context.Context) (domain.DataCapacity, error)
	Preview(context.Context, domain.PurgeSelection) (domain.PurgePreview, error)
	Purge(context.Context, domain.PurgeSelection, bool) (domain.PurgeResult, error)
}

type dataManagementBackupUsecase interface {
	CreateBackup(context.Context, string, usecase.BackupProgressReporter) (domain.BackupArtifact, error)
}

type dataManagementRestoreValidationUsecase interface {
	ValidateArchive(context.Context, string) (domain.RestoreValidationResult, error)
	RunRestoreTrial(context.Context, string) (domain.RestoreTrialState, error)
	RestoreTrialState() domain.RestoreTrialState
}

type dataManagementRestoreApplyUsecase interface {
	Apply(context.Context, string, bool) (domain.RestoreApplyResult, error)
}

// DataManagementService is the M09 input adapter. It deliberately exposes no
// database entities, raw errors, secrets, or credential-store facts. The
// user-selected backup output path is returned as an artifact fact.
type DataManagementService struct {
	purge      dataManagementPurgeUsecase
	backup     dataManagementBackupUsecase
	validation dataManagementRestoreValidationUsecase
	apply      dataManagementRestoreApplyUsecase
	gate       *usecase.MaintenanceGate
	recovery   domain.RestoreRecoveryResult
	appVersion string
	schema     int64

	mu                sync.Mutex
	operationActive   bool
	operationPhase    string
	cancelAllowed     bool
	currentCancel     context.CancelFunc
	backupState       DataManagementBackupStateSnapshot
	purgeState        DataManagementPurgeStateSnapshot
	validationState   DataManagementRestoreValidationStateSnapshot
	restoreApplyState DataManagementRestoreApplyStateSnapshot
}

type DataManagementErrorSnapshot struct {
	Code                 string   `json:"code"`
	Message              string   `json:"message"`
	Details              []string `json:"details"`
	RolledBack           bool     `json:"rolledBack"`
	CurrentDataUnchanged bool     `json:"currentDataUnchanged"`
}

type DataManagementCapacitySnapshot struct {
	DatabaseSizeBytes int64  `json:"databaseSizeBytes"`
	RawSnapshotCount  int64  `json:"rawSnapshotCount"`
	OldestCompletedAt string `json:"oldestCompletedAt"`
	LatestCompletedAt string `json:"latestCompletedAt"`
	RawJSONBytes      int64  `json:"rawJsonBytes"`
}

type DataManagementCapacityResultSnapshot struct {
	Status   string                          `json:"status"`
	Capacity *DataManagementCapacitySnapshot `json:"capacity"`
	Error    *DataManagementErrorSnapshot    `json:"error"`
}

type DataManagementPurgeSelectionInput struct {
	AllHubs          bool     `json:"allHubs"`
	HubIDs           []string `json:"hubIds"`
	StartAt          string   `json:"startAt"`
	EndAt            string   `json:"endAt"`
	ConfirmationText string   `json:"confirmationText"`
}

type DataManagementPurgeSelectionSnapshot struct {
	AllHubs bool     `json:"allHubs"`
	HubIDs  []string `json:"hubIds"`
	StartAt string   `json:"startAt"`
	EndAt   string   `json:"endAt"`
}

type DataManagementPurgePreviewSnapshot struct {
	Selection                DataManagementPurgeSelectionSnapshot `json:"selection"`
	Capacity                 DataManagementCapacitySnapshot       `json:"capacity"`
	RequiredConfirmationText string                               `json:"requiredConfirmationText"`
}

type DataManagementPurgeResultSnapshot struct {
	AuditID                  string `json:"auditId"`
	ExecutedAt               string `json:"executedAt"`
	RawSnapshotCount         int64  `json:"rawSnapshotCount"`
	CostObservationCount     int64  `json:"costObservationCount"`
	LimitObservationCount    int64  `json:"limitObservationCount"`
	MatchedObservationCount  int64  `json:"matchedObservationCount"`
	EstimationPointCount     int64  `json:"estimationPointCount"`
	EstimationResultCount    int64  `json:"estimationResultCount"`
	EstimationEvidenceCount  int64  `json:"estimationEvidenceCount"`
	CalculationIntervalCount int64  `json:"calculationIntervalCount"`
	CalculationBoundaryCount int64  `json:"calculationBoundaryCount"`
	RecalculatedResultCount  int64  `json:"recalculatedResultCount"`
}

type DataManagementPurgeStateSnapshot struct {
	Status        string                              `json:"status"`
	CancelAllowed bool                                `json:"cancelAllowed"`
	Preview       *DataManagementPurgePreviewSnapshot `json:"preview"`
	Result        *DataManagementPurgeResultSnapshot  `json:"result"`
	Error         *DataManagementErrorSnapshot        `json:"error"`
}

type DataManagementArtifactSnapshot struct {
	Path           string `json:"path"`
	ArtifactSHA256 string `json:"artifactSha256"`
	SizeBytes      int64  `json:"sizeBytes"`
	FormatVersion  int    `json:"formatVersion"`
	SchemaVersion  int64  `json:"schemaVersion"`
	AppVersion     string `json:"appVersion"`
	CreatedAt      string `json:"createdAt"`
	Warning        string `json:"warning"`
}

type DataManagementBackupStateSnapshot struct {
	Status        string                          `json:"status"`
	CancelAllowed bool                            `json:"cancelAllowed"`
	Artifact      *DataManagementArtifactSnapshot `json:"artifact"`
	Error         *DataManagementErrorSnapshot    `json:"error"`
}

type DataManagementRestoreValidationStateSnapshot struct {
	Status        string                          `json:"status"`
	CancelAllowed bool                            `json:"cancelAllowed"`
	ApplyAllowed  bool                            `json:"applyAllowed"`
	OperationID   string                          `json:"operationId"`
	Artifact      *DataManagementArtifactSnapshot `json:"artifact"`
	Error         *DataManagementErrorSnapshot    `json:"error"`
}

type DataManagementRestoreTrialStateSnapshot struct {
	Status         string                       `json:"status"`
	CancelAllowed  bool                         `json:"cancelAllowed"`
	ArtifactSHA256 string                       `json:"artifactSha256"`
	TestedAt       string                       `json:"testedAt"`
	Warning        string                       `json:"warning"`
	Error          *DataManagementErrorSnapshot `json:"error"`
}

type DataManagementRestoreApplyStateSnapshot struct {
	Status                           string                          `json:"status"`
	Phase                            string                          `json:"phase"`
	CancelAllowed                    bool                            `json:"cancelAllowed"`
	CancellationBoundary             string                          `json:"cancellationBoundary"`
	OperationID                      string                          `json:"operationId"`
	Artifact                         *DataManagementArtifactSnapshot `json:"artifact"`
	RestoredAt                       string                          `json:"restoredAt"`
	AuditID                          string                          `json:"auditId"`
	RollbackSucceeded                bool                            `json:"rollbackSucceeded"`
	Warning                          string                          `json:"warning"`
	CredentialState                  string                          `json:"credentialState"`
	RequiresCredentialReregistration bool                            `json:"requiresCredentialReregistration"`
	Error                            *DataManagementErrorSnapshot    `json:"error"`
}

type DataManagementRestoreStateSnapshot struct {
	Validation DataManagementRestoreValidationStateSnapshot `json:"validation"`
	Trial      DataManagementRestoreTrialStateSnapshot      `json:"trial"`
	Apply      DataManagementRestoreApplyStateSnapshot      `json:"apply"`
}

type DataManagementRecoveryNoticeSnapshot struct {
	Status         string `json:"status"`
	ArtifactSHA256 string `json:"artifactSha256"`
	Message        string `json:"message"`
}

type DataManagementMaintenanceSnapshot struct {
	Active               bool   `json:"active"`
	Operation            string `json:"operation"`
	Phase                string `json:"phase"`
	CancelAllowed        bool   `json:"cancelAllowed"`
	CancellationBoundary string `json:"cancellationBoundary"`
}

type DataManagementCancellationSnapshot struct {
	Status               string                       `json:"status"`
	Phase                string                       `json:"phase"`
	CancelAllowed        bool                         `json:"cancelAllowed"`
	CancellationBoundary string                       `json:"cancellationBoundary"`
	Message              string                       `json:"message"`
	Error                *DataManagementErrorSnapshot `json:"error"`
}

type DataManagementStateSnapshot struct {
	Capacity    DataManagementCapacityResultSnapshot `json:"capacity"`
	Purge       DataManagementPurgeStateSnapshot     `json:"purge"`
	Backup      DataManagementBackupStateSnapshot    `json:"backup"`
	Restore     DataManagementRestoreStateSnapshot   `json:"restore"`
	Recovery    DataManagementRecoveryNoticeSnapshot `json:"recovery"`
	Maintenance DataManagementMaintenanceSnapshot    `json:"maintenance"`
}

func NewDataManagementService(
	purge *usecase.PurgeUsecase,
	backup *usecase.BackupUsecase,
	validation *usecase.RestoreValidationUsecase,
	apply *usecase.RestoreApplyUsecase,
	gate *usecase.MaintenanceGate,
	recovery domain.RestoreRecoveryResult,
	appVersion string,
	schemaVersion int64,
) (*DataManagementService, error) {
	return NewDataManagementServiceWithDependencies(purge, backup, validation, apply, gate, recovery, appVersion, schemaVersion)
}

func NewDataManagementServiceWithDependencies(
	purge dataManagementPurgeUsecase,
	backup dataManagementBackupUsecase,
	validation dataManagementRestoreValidationUsecase,
	apply dataManagementRestoreApplyUsecase,
	gate *usecase.MaintenanceGate,
	recovery domain.RestoreRecoveryResult,
	appVersion string,
	schemaVersion int64,
) (*DataManagementService, error) {
	if purge == nil || backup == nil || validation == nil || apply == nil || gate == nil {
		return nil, errors.New("data management service dependencies are required")
	}
	if strings.TrimSpace(appVersion) == "" || schemaVersion <= 0 {
		return nil, errors.New("data management artifact versions are required")
	}
	if !validRestoreRecoveryStatus(recovery.Status) {
		return nil, errors.New("data management recovery status is invalid")
	}
	return &DataManagementService{
		purge: purge, backup: backup, validation: validation, apply: apply, gate: gate,
		recovery: recovery, appVersion: strings.TrimSpace(appVersion), schema: schemaVersion,
		backupState:       DataManagementBackupStateSnapshot{Status: "not_run"},
		purgeState:        DataManagementPurgeStateSnapshot{Status: "not_run"},
		validationState:   DataManagementRestoreValidationStateSnapshot{Status: "not_run"},
		restoreApplyState: DataManagementRestoreApplyStateSnapshot{Status: "not_run"},
	}, nil
}

func (s *DataManagementService) GetState(ctx context.Context) DataManagementStateSnapshot {
	capacity := s.GetCapacity(ctx)
	s.mu.Lock()
	backup := s.backupState
	purge := s.purgeState
	validation := s.validationState
	apply := s.restoreApplyState
	s.mu.Unlock()
	return DataManagementStateSnapshot{
		Capacity: capacity,
		Purge:    purge,
		Backup:   backup,
		Restore: DataManagementRestoreStateSnapshot{
			Validation: validation,
			Trial:      s.currentRestoreTrialState(),
			Apply:      apply,
		},
		Recovery:    s.GetRecoveryNotice(),
		Maintenance: s.GetMaintenanceState(),
	}
}

func (s *DataManagementService) GetCapacity(ctx context.Context) DataManagementCapacityResultSnapshot {
	capacity, err := s.purge.Capacity(ctx)
	if err != nil {
		return DataManagementCapacityResultSnapshot{Status: "failed", Error: dataManagementError("capacity_failed", "容量情報を取得できませんでした。", nil, false, true)}
	}
	if err := capacity.Validate(); err != nil {
		return DataManagementCapacityResultSnapshot{Status: "failed", Error: dataManagementError("capacity_invalid", "容量情報を表示できませんでした。", nil, false, true)}
	}
	mapped := mapDataManagementCapacity(capacity)
	return DataManagementCapacityResultSnapshot{Status: "success", Capacity: &mapped}
}

func (s *DataManagementService) PreviewPurge(ctx context.Context, input DataManagementPurgeSelectionInput) DataManagementPurgeStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "purge_preview", true)
	if !started {
		return DataManagementPurgeStateSnapshot{Status: "failed", Error: maintenanceBusyError()}
	}
	defer s.endOperation()
	selection, err := mapDataManagementPurgeSelection(input)
	if err != nil {
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: dataManagementError("purge_selection_invalid", "パージ対象の指定を確認してください。", nil, false, true)}
		s.setPurgeState(state)
		return state
	}
	lease, err := s.gate.Acquire(operationContext, usecase.MaintenancePurge)
	if err != nil {
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: mapMaintenanceError(err)}
		s.setPurgeState(state)
		return state
	}
	defer lease.Release()
	s.setPurgeState(DataManagementPurgeStateSnapshot{Status: "previewing", CancelAllowed: true})
	preview, err := s.purge.Preview(operationContext, selection)
	if err != nil {
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: mapPurgeError(err, false)}
		s.setPurgeState(state)
		return state
	}
	mapped := mapDataManagementPurgePreview(preview)
	state := DataManagementPurgeStateSnapshot{Status: "ready", Preview: &mapped}
	s.setPurgeState(state)
	return state
}

func (s *DataManagementService) ApplyPurge(ctx context.Context, input DataManagementPurgeSelectionInput, confirmed bool) DataManagementPurgeStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "purge_apply", false)
	if !started {
		return DataManagementPurgeStateSnapshot{Status: "failed", Error: maintenanceBusyError()}
	}
	defer s.endOperation()
	selection, err := mapDataManagementPurgeSelection(input)
	if err != nil {
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: dataManagementError("purge_selection_invalid", "パージ対象の指定を確認してください。", nil, false, true)}
		s.setPurgeState(state)
		return state
	}
	if isFullPurgeSelection(selection) && input.ConfirmationText != DataManagementFullPurgeConfirmationText {
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: dataManagementError("purge_confirmation_text_required", "全Hub・全期間のパージには表示された確認語句の正確な入力が必要です。", nil, false, true)}
		s.setPurgeState(state)
		return state
	}
	s.setPurgeState(DataManagementPurgeStateSnapshot{Status: "applying"})
	result, err := s.purge.Purge(operationContext, selection, confirmed)
	if err != nil {
		mappedError := mapPurgeError(err, true)
		if !confirmed {
			mappedError = dataManagementError("purge_confirmation_required", "パージを実行するには最終確認が必要です。", nil, false, true)
		}
		state := DataManagementPurgeStateSnapshot{Status: "failed", Error: mappedError}
		s.setPurgeState(state)
		return state
	}
	mapped := mapDataManagementPurgeResult(result)
	state := DataManagementPurgeStateSnapshot{Status: "success", Result: &mapped}
	s.setPurgeState(state)
	return state
}

func (s *DataManagementService) CreateBackup(ctx context.Context, destinationPath string) DataManagementBackupStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "backup_create", false)
	if !started {
		return DataManagementBackupStateSnapshot{Status: "failed", Error: maintenanceBusyError()}
	}
	defer s.endOperation()
	if strings.TrimSpace(destinationPath) == "" {
		state := DataManagementBackupStateSnapshot{Status: "failed", Error: dataManagementError("backup_destination_required", "バックアップの保存先を選択してください。", nil, false, true)}
		s.setBackupState(state)
		return state
	}
	s.setBackupState(DataManagementBackupStateSnapshot{Status: "creating"})
	artifact, err := s.backup.CreateBackup(operationContext, destinationPath, s.reportBackupProgress)
	if err != nil {
		state := DataManagementBackupStateSnapshot{Status: "failed", Error: mapBackupError(err)}
		s.setBackupState(state)
		return state
	}
	mapped := DataManagementArtifactSnapshot{
		Path:           artifact.Path,
		ArtifactSHA256: artifact.ArtifactSHA256,
		SizeBytes:      artifact.SizeBytes,
		FormatVersion:  domain.BackupFormatVersion,
		SchemaVersion:  s.schema,
		AppVersion:     s.appVersion,
		CreatedAt:      formatDataManagementTime(artifact.CreatedAt),
		Warning:        artifact.Warning,
	}
	state := DataManagementBackupStateSnapshot{Status: "success", Artifact: &mapped}
	s.setBackupState(state)
	return state
}

func (s *DataManagementService) ValidateRestore(ctx context.Context, archivePath string) DataManagementRestoreValidationStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "restore_validation", true)
	if !started {
		return DataManagementRestoreValidationStateSnapshot{Status: "failed", Error: maintenanceBusyError()}
	}
	defer s.endOperation()
	if strings.TrimSpace(archivePath) == "" {
		state := DataManagementRestoreValidationStateSnapshot{Status: "failed", Error: dataManagementError("restore_archive_required", "復元するバックアップZIPを選択してください。", nil, false, true)}
		s.setValidationState(state)
		return state
	}
	s.setValidationState(DataManagementRestoreValidationStateSnapshot{Status: "validating", CancelAllowed: true})
	result, err := s.validation.ValidateArchive(operationContext, archivePath)
	if err != nil {
		state := DataManagementRestoreValidationStateSnapshot{Status: "failed", Error: mapRestoreValidationError(err)}
		s.setValidationState(state)
		return state
	}
	mapped := DataManagementArtifactSnapshot{
		ArtifactSHA256: result.ArtifactSHA256,
		FormatVersion:  result.FormatVersion,
		SchemaVersion:  result.SchemaVersion,
		CreatedAt:      formatDataManagementTime(result.ArtifactCreatedAt),
	}
	state := DataManagementRestoreValidationStateSnapshot{Status: "success", ApplyAllowed: true, OperationID: result.OperationID, Artifact: &mapped}
	s.setValidationState(state)
	return state
}

func (s *DataManagementService) RunRestoreTrial(ctx context.Context, operationID string) DataManagementRestoreTrialStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "restore_trial", true)
	if !started {
		state := mapDataManagementTrialState(s.validation.RestoreTrialState())
		state.Error = maintenanceBusyError()
		return state
	}
	defer s.endOperation()
	if strings.TrimSpace(operationID) == "" {
		state := mapDataManagementTrialState(s.validation.RestoreTrialState())
		state.Error = dataManagementError("restore_operation_required", "先にバックアップZIPを検証してください。", nil, false, true)
		return state
	}
	result, err := s.validation.RunRestoreTrial(operationContext, operationID)
	state := mapDataManagementTrialState(result)
	if err != nil {
		state.Error = mapRestoreTrialError(err, result)
	}
	return state
}

func (s *DataManagementService) GetRestoreState() DataManagementRestoreStateSnapshot {
	s.mu.Lock()
	validation := s.validationState
	apply := s.restoreApplyState
	s.mu.Unlock()
	return DataManagementRestoreStateSnapshot{
		Validation: validation,
		Trial:      s.currentRestoreTrialState(),
		Apply:      apply,
	}
}

func (s *DataManagementService) ApplyRestore(ctx context.Context, operationID string, confirmed bool) DataManagementRestoreApplyStateSnapshot {
	operationContext, started := s.beginOperation(ctx, "restore_apply", true)
	if !started {
		return DataManagementRestoreApplyStateSnapshot{Status: "failed", Error: maintenanceBusyError()}
	}
	defer s.endOperation()
	if strings.TrimSpace(operationID) == "" {
		state := DataManagementRestoreApplyStateSnapshot{Status: "failed", Error: dataManagementError("restore_operation_required", "先にバックアップZIPを検証してください。", nil, false, true)}
		s.setRestoreApplyState(state)
		return state
	}
	s.setRestoreApplyState(DataManagementRestoreApplyStateSnapshot{
		Status: "applying", Phase: "restore_apply", CancelAllowed: true,
		CancellationBoundary: "before_atomic_replace_only", OperationID: operationID,
	})
	result, err := s.apply.Apply(operationContext, operationID, confirmed)
	if err != nil {
		if confirmed && !errors.Is(err, usecase.ErrMaintenanceBusy) {
			s.invalidateValidationOperation()
		}
		mappedError := mapRestoreApplyError(err, result)
		if !confirmed {
			mappedError = dataManagementError("restore_confirmation_required", "復元を適用するには最終確認が必要です。", nil, false, true)
		}
		state := DataManagementRestoreApplyStateSnapshot{
			Status: "failed", Phase: "restore_apply", CancellationBoundary: "before_atomic_replace_only",
			OperationID: operationID, RollbackSucceeded: result.RollbackSucceeded, Error: mappedError,
		}
		if result.ArtifactSHA256 != "" {
			state.Artifact = &DataManagementArtifactSnapshot{ArtifactSHA256: result.ArtifactSHA256, FormatVersion: result.FormatVersion, SchemaVersion: result.SchemaVersion}
		}
		s.setRestoreApplyState(state)
		return state
	}
	s.invalidateValidationOperation()
	artifact := DataManagementArtifactSnapshot{
		ArtifactSHA256: result.ArtifactSHA256,
		FormatVersion:  result.FormatVersion,
		SchemaVersion:  result.SchemaVersion,
	}
	state := DataManagementRestoreApplyStateSnapshot{
		Status: "success", Phase: "completed", CancellationBoundary: "before_atomic_replace_only",
		OperationID: result.OperationID, Artifact: &artifact,
		RestoredAt: formatDataManagementTime(result.RestoredAt), AuditID: result.AuditID,
		RollbackSucceeded: false, Warning: result.Warning,
		CredentialState: string(domain.CredentialPostRestorePending), RequiresCredentialReregistration: true,
	}
	s.setRestoreApplyState(state)
	return state
}

func (s *DataManagementService) GetRecoveryNotice() DataManagementRecoveryNoticeSnapshot {
	result := DataManagementRecoveryNoticeSnapshot{Status: string(s.recovery.Status), ArtifactSHA256: s.recovery.ArtifactSHA256}
	switch s.recovery.Status {
	case domain.RestoreRecoveryNone:
		result.Message = "起動時に回復が必要な復元はありません。"
	case domain.RestoreRecoveryRolledBack:
		result.Message = "未完了の復元を検出し、元のデータベースへ戻しました。"
	case domain.RestoreRecoveryCommittedCleaned:
		result.Message = "完了済みの復元を確認し、一時ファイルを整理しました。"
	}
	return result
}

func (s *DataManagementService) GetMaintenanceState() DataManagementMaintenanceSnapshot {
	operation := s.gate.ActiveOperation()
	s.mu.Lock()
	phase := s.operationPhase
	cancelAllowed := s.cancelAllowed
	s.mu.Unlock()
	return DataManagementMaintenanceSnapshot{
		Active: operation != "" || phase != "", Operation: string(operation),
		Phase: phase, CancelAllowed: cancelAllowed, CancellationBoundary: cancellationBoundaryForPhase(phase),
	}
}

func (s *DataManagementService) currentRestoreTrialState() DataManagementRestoreTrialStateSnapshot {
	state := mapDataManagementTrialState(s.validation.RestoreTrialState())
	s.mu.Lock()
	if s.operationPhase == "restore_trial" {
		state.CancelAllowed = s.cancelAllowed
	}
	s.mu.Unlock()
	return state
}

func (s *DataManagementService) CancelCurrentOperation() DataManagementCancellationSnapshot {
	s.mu.Lock()
	if !s.operationActive {
		s.mu.Unlock()
		return DataManagementCancellationSnapshot{
			Status: "rejected",
			Error:  dataManagementError("operation_not_running", "キャンセルできる操作は実行されていません。", nil, false, true),
		}
	}
	phase := s.operationPhase
	boundary := cancellationBoundaryForPhase(phase)
	if !s.cancelAllowed || s.currentCancel == nil {
		s.mu.Unlock()
		return DataManagementCancellationSnapshot{
			Status: "rejected", Phase: phase, CancellationBoundary: boundary,
			Error: dataManagementError("operation_not_cancelable", "この段階の操作はキャンセルできません。", []string{"処理が完了するまでお待ちください。"}, false, false),
		}
	}
	cancel := s.currentCancel
	s.cancelAllowed = false
	s.disableStateCancellationLocked(phase)
	s.mu.Unlock()
	cancel()
	message := "取消要求を送信しました。"
	if phase == "restore_apply" {
		message = "入替え開始前なら復元を取り消します。入替え開始後は安全のため処理を完遂します。"
	}
	return DataManagementCancellationSnapshot{
		Status: "cancellation_requested", Phase: phase, CancelAllowed: false,
		CancellationBoundary: boundary, Message: message,
	}
}

func (s *DataManagementService) beginOperation(ctx context.Context, phase string, allowCancel bool) (context.Context, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.operationActive {
		return ctx, false
	}
	s.operationActive = true
	s.operationPhase = phase
	s.cancelAllowed = allowCancel
	if !allowCancel {
		return ctx, true
	}
	operationContext, cancel := context.WithCancel(ctx)
	s.currentCancel = cancel
	return operationContext, true
}

func (s *DataManagementService) endOperation() {
	s.mu.Lock()
	if s.currentCancel != nil {
		s.currentCancel()
	}
	s.operationActive = false
	s.operationPhase = ""
	s.cancelAllowed = false
	s.currentCancel = nil
	s.mu.Unlock()
}

func (s *DataManagementService) disableStateCancellationLocked(phase string) {
	switch phase {
	case "purge_preview":
		s.purgeState.CancelAllowed = false
	case "restore_validation":
		s.validationState.CancelAllowed = false
	case "restore_apply":
		s.restoreApplyState.CancelAllowed = false
	}
}

func (s *DataManagementService) setBackupState(state DataManagementBackupStateSnapshot) {
	s.mu.Lock()
	s.backupState = state
	s.mu.Unlock()
}

func (s *DataManagementService) reportBackupProgress(progress usecase.BackupProgress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.operationPhase != "backup_create" {
		return
	}
	switch progress {
	case usecase.BackupProgressCreating:
		s.backupState = DataManagementBackupStateSnapshot{Status: "creating"}
	case usecase.BackupProgressValidating:
		s.backupState = DataManagementBackupStateSnapshot{Status: "validating"}
	}
}

func (s *DataManagementService) setPurgeState(state DataManagementPurgeStateSnapshot) {
	s.mu.Lock()
	s.purgeState = state
	s.mu.Unlock()
}

func (s *DataManagementService) setValidationState(state DataManagementRestoreValidationStateSnapshot) {
	s.mu.Lock()
	s.validationState = state
	s.mu.Unlock()
}

func (s *DataManagementService) invalidateValidationOperation() {
	s.mu.Lock()
	s.validationState.ApplyAllowed = false
	s.validationState.OperationID = ""
	s.mu.Unlock()
}

func (s *DataManagementService) setRestoreApplyState(state DataManagementRestoreApplyStateSnapshot) {
	s.mu.Lock()
	s.restoreApplyState = state
	s.mu.Unlock()
}

func mapDataManagementCapacity(value domain.DataCapacity) DataManagementCapacitySnapshot {
	return DataManagementCapacitySnapshot{
		DatabaseSizeBytes: value.DatabaseSizeBytes,
		RawSnapshotCount:  value.RawSnapshotCount,
		OldestCompletedAt: formatDataManagementTimePointer(value.OldestCompletedAt),
		LatestCompletedAt: formatDataManagementTimePointer(value.LatestCompletedAt),
		RawJSONBytes:      value.RawJSONBytes,
	}
}

func mapDataManagementPurgeSelection(input DataManagementPurgeSelectionInput) (domain.PurgeSelection, error) {
	start, err := parseDataManagementTime(input.StartAt)
	if err != nil {
		return domain.PurgeSelection{}, err
	}
	end, err := parseDataManagementTime(input.EndAt)
	if err != nil {
		return domain.PurgeSelection{}, err
	}
	selection := domain.PurgeSelection{AllHubs: input.AllHubs, HubIDs: append([]string(nil), input.HubIDs...), Start: start, End: end}
	return selection, nil
}

func mapDataManagementPurgePreview(value domain.PurgePreview) DataManagementPurgePreviewSnapshot {
	result := DataManagementPurgePreviewSnapshot{
		Selection: DataManagementPurgeSelectionSnapshot{
			AllHubs: value.Selection.AllHubs, HubIDs: append([]string(nil), value.Selection.HubIDs...),
			StartAt: formatDataManagementTimePointer(value.Selection.Start), EndAt: formatDataManagementTimePointer(value.Selection.End),
		},
		Capacity: mapDataManagementCapacity(value.Capacity),
	}
	if isFullPurgeSelection(value.Selection) {
		result.RequiredConfirmationText = DataManagementFullPurgeConfirmationText
	}
	return result
}

func mapDataManagementPurgeResult(value domain.PurgeResult) DataManagementPurgeResultSnapshot {
	return DataManagementPurgeResultSnapshot{
		AuditID: value.AuditID, ExecutedAt: formatDataManagementTime(value.ExecutedAt), RawSnapshotCount: value.RawSnapshotCount,
		CostObservationCount: value.CostObservationCount, LimitObservationCount: value.LimitObservationCount,
		MatchedObservationCount: value.MatchedObservationCount, EstimationPointCount: value.EstimationPointCount,
		EstimationResultCount: value.EstimationResultCount, EstimationEvidenceCount: value.EstimationEvidenceCount,
		CalculationIntervalCount: value.CalculationIntervalCount, CalculationBoundaryCount: value.CalculationBoundaryCount,
		RecalculatedResultCount: value.RecalculatedResultCount,
	}
}

func isFullPurgeSelection(selection domain.PurgeSelection) bool {
	return selection.AllHubs && selection.Start == nil && selection.End == nil
}

func mapDataManagementTrialState(value domain.RestoreTrialState) DataManagementRestoreTrialStateSnapshot {
	state := DataManagementRestoreTrialStateSnapshot{
		Status: string(value.Status), CancelAllowed: value.Status == domain.RestoreTrialRunning,
		ArtifactSHA256: value.ArtifactSHA256, TestedAt: formatDataManagementTime(value.TestedAt), Warning: value.Warning,
	}
	if value.Status == domain.RestoreTrialFailed {
		if value.FailureCode != "" {
			state.Error = restoreValidationErrorSnapshot(value.FailureCode)
		} else {
			state.Error = dataManagementError("restore_trial_failed", "隔離復元試験に失敗しました。", nil, false, true)
		}
	}
	return state
}

func parseDataManagementTime(value string) (*time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return nil, err
	}
	utc := parsed.UTC()
	return &utc, nil
}

func formatDataManagementTimePointer(value *time.Time) string {
	if value == nil {
		return ""
	}
	return formatDataManagementTime(*value)
}

func formatDataManagementTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func mapMaintenanceError(err error) *DataManagementErrorSnapshot {
	if errors.Is(err, context.Canceled) {
		return dataManagementError("operation_canceled", "操作をキャンセルしました。", nil, false, true)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return dataManagementError("operation_timed_out", "操作の待機時間を超えました。", nil, false, true)
	}
	if errors.Is(err, usecase.ErrMaintenanceBusy) {
		return maintenanceBusyError()
	}
	return dataManagementError("maintenance_failed", "保守操作を開始できませんでした。", nil, false, true)
}

func mapPurgeError(err error, applying bool) *DataManagementErrorSnapshot {
	if mapped := mapContextOrMaintenanceError(err); mapped != nil {
		return mapped
	}
	if errors.Is(err, domain.ErrPurgeSelectionHubs) || errors.Is(err, domain.ErrPurgeSelectionRange) {
		return dataManagementError("purge_selection_invalid", "パージ対象の指定を確認してください。", nil, false, true)
	}
	if errors.Is(err, domain.ErrPurgeNoTargets) {
		return dataManagementError("purge_no_targets", "指定した範囲に削除対象の原JSONはありません。", nil, false, true)
	}
	if applying {
		return dataManagementError("purge_failed_rolled_back", "パージと再計算に失敗し、変更をロールバックしました。", []string{"削除結果はコミットされていません。"}, true, true)
	}
	return dataManagementError("purge_preview_failed", "パージ対象を確認できませんでした。", nil, false, true)
}

func mapBackupError(err error) *DataManagementErrorSnapshot {
	if mapped := mapContextOrMaintenanceError(err); mapped != nil {
		return mapped
	}
	return dataManagementError("backup_failed", "バックアップを作成できませんでした。", []string{"既存の同名成果物は変更されていません。"}, false, true)
}

func mapRestoreValidationError(err error) *DataManagementErrorSnapshot {
	if mapped := mapContextOrMaintenanceError(err); mapped != nil {
		return mapped
	}
	var validationErr *domain.RestoreValidationError
	if errors.As(err, &validationErr) {
		return restoreValidationErrorSnapshot(validationErr.Code)
	}
	return dataManagementError("restore_validation_failed", "バックアップZIPを検証できませんでした。", nil, false, true)
}

func mapRestoreTrialError(err error, state domain.RestoreTrialState) *DataManagementErrorSnapshot {
	if mapped := mapContextOrMaintenanceError(err); mapped != nil {
		return mapped
	}
	var validationErr *domain.RestoreValidationError
	if errors.As(err, &validationErr) {
		return restoreValidationErrorSnapshot(validationErr.Code)
	}
	if state.FailureCode != "" {
		return restoreValidationErrorSnapshot(state.FailureCode)
	}
	return dataManagementError("restore_trial_failed", "隔離復元試験に失敗しました。", nil, false, true)
}

func mapRestoreApplyError(err error, result domain.RestoreApplyResult) *DataManagementErrorSnapshot {
	if errors.Is(err, usecase.ErrMaintenanceBusy) {
		return maintenanceBusyError()
	}
	if errors.Is(err, context.Canceled) && result.RollbackSucceeded {
		return dataManagementError("restore_canceled_before_replace", "入替え開始前に復元をキャンセルしました。", []string{"現在のローカル正本は変更されていません。"}, true, true)
	}
	if result.RollbackSucceeded {
		return dataManagementError("restore_failed_rolled_back", "復元に失敗し、元のデータベースへ戻しました。", []string{"現在のローカル正本は変更されていません。"}, true, true)
	}
	if errors.Is(err, context.Canceled) {
		return dataManagementError("restore_failed", "復元を完了できませんでした。", []string{"入替え開始後の復元はキャンセルできません。"}, false, false)
	}
	return dataManagementError("restore_failed", "復元を完了できませんでした。", []string{"回復結果を確認してください。"}, false, false)
}

func cancellationBoundaryForPhase(phase string) string {
	switch phase {
	case "purge_preview", "restore_validation", "restore_trial":
		return "until_operation_finishes"
	case "restore_apply":
		return "before_atomic_replace_only"
	default:
		return "none"
	}
}

func mapContextOrMaintenanceError(err error) *DataManagementErrorSnapshot {
	if errors.Is(err, context.Canceled) {
		return dataManagementError("operation_canceled", "操作をキャンセルしました。", nil, false, true)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return dataManagementError("operation_timed_out", "操作の待機時間を超えました。", nil, false, true)
	}
	if errors.Is(err, usecase.ErrMaintenanceBusy) {
		return maintenanceBusyError()
	}
	return nil
}

func restoreValidationErrorSnapshot(code domain.RestoreValidationCode) *DataManagementErrorSnapshot {
	message := map[domain.RestoreValidationCode]string{
		domain.RestoreValidationArchive:        "バックアップZIPを読み取れません。",
		domain.RestoreValidationZIPEntry:       "バックアップZIPの内容構成が正しくありません。",
		domain.RestoreValidationZIPCRC:         "バックアップZIPのCRC検証に失敗しました。",
		domain.RestoreValidationManifestBOM:    "manifest.jsonにUTF-8 BOMが含まれています。",
		domain.RestoreValidationManifestJSON:   "manifest.jsonのJSON形式が正しくありません。",
		domain.RestoreValidationManifestKey:    "manifest.jsonのキー構成が正しくありません。",
		domain.RestoreValidationFormatVersion:  "このバックアップ形式には対応していません。",
		domain.RestoreValidationSchemaVersion:  "このスキーマ版には対応していません。",
		domain.RestoreValidationDeclaredSize:   "宣言されたデータベースサイズと内容が一致しません。",
		domain.RestoreValidationFreeSpace:      "復元検証に必要な空き容量がありません。",
		domain.RestoreValidationDatabaseSHA:    "データベースのSHA-256が一致しません。",
		domain.RestoreValidationIntegrity:      "SQLiteの整合性検証に失敗しました。",
		domain.RestoreValidationRequiredSchema: "必須のテーブルまたは列が不足しています。",
		domain.RestoreValidationEnum:           "保存値に未対応の状態コードが含まれています。",
		domain.RestoreValidationDatetime:       "保存されたUTC日時が正しくありません。",
		domain.RestoreValidationForeignKey:     "参照整合性の検証に失敗しました。",
		domain.RestoreValidationInterval:       "保存された有効期間が重複しています。",
		domain.RestoreValidationSecret:         "バックアップに保存禁止の秘密データが含まれています。",
		domain.RestoreValidationRecalculation:  "復元後の再計算可能性を確認できません。",
		domain.RestoreValidationComparison:     "隔離復元した論理内容が成果物と一致しません。",
	}[code]
	if message == "" {
		return dataManagementError("restore_validation_failed", "バックアップZIPを検証できませんでした。", nil, false, true)
	}
	return dataManagementError("restore_validation_"+string(code), message, []string{"検証項目: " + string(code)}, false, true)
}

func maintenanceBusyError() *DataManagementErrorSnapshot {
	return dataManagementError("maintenance_busy", "別の収集、編集、パージ、バックアップ、または復元が実行中です。", nil, false, true)
}

func dataManagementError(code, message string, details []string, rolledBack, unchanged bool) *DataManagementErrorSnapshot {
	if details == nil {
		details = []string{}
	}
	return &DataManagementErrorSnapshot{Code: code, Message: message, Details: details, RolledBack: rolledBack, CurrentDataUnchanged: unchanged}
}

func validRestoreRecoveryStatus(status domain.RestoreRecoveryStatus) bool {
	switch status {
	case domain.RestoreRecoveryNone, domain.RestoreRecoveryRolledBack, domain.RestoreRecoveryCommittedCleaned:
		return true
	default:
		return false
	}
}
