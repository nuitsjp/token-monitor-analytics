package usecase

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"token-monitor-analytics/internal/domain"
)

type RestoreArchiveValidator interface {
	ValidateAndExtract(context.Context, string, string, int64) (domain.BackupManifest, string, string, error)
}

type RestoreDatabaseValidator interface {
	ApplicationDataDirectory() (string, error)
	SchemaVersion() int64
	ValidateRestoreDatabase(context.Context, string, domain.BackupManifest) error
	RunIsolatedRestoreTrial(context.Context, string, string, domain.BackupManifest) error
}

type RestoreTrialRecorder interface {
	RecordRestoreTrial(context.Context, domain.RestoreTrialState) error
}

type validatedRestore struct {
	operationID    string
	artifactSHA256 string
	manifest       domain.BackupManifest
	directory      string
	databasePath   string
}

type RestoreValidationUsecase struct {
	mu         sync.Mutex
	database   RestoreDatabaseValidator
	archive    RestoreArchiveValidator
	recorder   RestoreTrialRecorder
	clock      Clock
	ids        IDGenerator
	current    *validatedRestore
	state      domain.RestoreTrialState
	validating bool
	running    bool
}

func NewRestoreValidationUsecase(database RestoreDatabaseValidator, archive RestoreArchiveValidator, recorder RestoreTrialRecorder, clock Clock, ids IDGenerator) (*RestoreValidationUsecase, error) {
	if database == nil || archive == nil || clock == nil || ids == nil {
		return nil, errors.New("restore validation usecase dependencies are required")
	}
	return &RestoreValidationUsecase{
		database: database,
		archive:  archive,
		recorder: recorder,
		clock:    clock,
		ids:      ids,
		state:    domain.RestoreTrialState{Status: domain.RestoreTrialNotRun},
	}, nil
}

func (u *RestoreValidationUsecase) ValidateArchive(ctx context.Context, archivePath string) (domain.RestoreValidationResult, error) {
	if strings.TrimSpace(archivePath) == "" {
		return domain.RestoreValidationResult{}, errors.New("restore archive path is required")
	}
	u.mu.Lock()
	if u.validating || u.running {
		u.mu.Unlock()
		return domain.RestoreValidationResult{}, errors.New("restore validation or trial is already running")
	}
	u.validating = true
	previous := u.current
	u.current = nil
	u.state = domain.RestoreTrialState{Status: domain.RestoreTrialNotRun}
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.validating = false
		u.mu.Unlock()
	}()

	workspaceRoot, err := u.database.ApplicationDataDirectory()
	if err != nil {
		return domain.RestoreValidationResult{}, fmt.Errorf("resolve restore workspace: %w", err)
	}
	if previous != nil {
		if err := removeManagedRestoreDirectory(workspaceRoot, previous.directory, "restore-validated-"); err != nil {
			return domain.RestoreValidationResult{}, fmt.Errorf("invalidate previous restore validation: %w", err)
		}
	}
	manifest, artifactSHA, directory, err := u.archive.ValidateAndExtract(ctx, archivePath, workspaceRoot, u.database.SchemaVersion())
	if err != nil {
		return domain.RestoreValidationResult{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = removeManagedRestoreDirectory(workspaceRoot, directory, "restore-validated-")
		}
	}()
	if err := validateManagedRestoreDirectory(workspaceRoot, directory, "restore-validated-"); err != nil {
		return domain.RestoreValidationResult{}, fmt.Errorf("accept restore validation directory: %w", err)
	}
	databasePath := filepath.Join(directory, manifest.Database.Path)
	if err := u.database.ValidateRestoreDatabase(ctx, databasePath, manifest); err != nil {
		return domain.RestoreValidationResult{}, err
	}
	operationID := strings.TrimSpace(u.ids.New())
	if operationID == "" {
		return domain.RestoreValidationResult{}, errors.New("restore validation operation ID is empty")
	}
	validated := &validatedRestore{
		operationID:    operationID,
		artifactSHA256: artifactSHA,
		manifest:       manifest,
		directory:      directory,
		databasePath:   databasePath,
	}
	state := domain.RestoreTrialState{Status: domain.RestoreTrialNotRun, ArtifactSHA256: artifactSHA}
	u.mu.Lock()
	u.current = validated
	u.state = state
	u.mu.Unlock()
	cleanup = false
	u.recordTrialState(ctx, state)
	return domain.RestoreValidationResult{
		OperationID:       operationID,
		ArtifactSHA256:    artifactSHA,
		FormatVersion:     manifest.FormatVersion,
		SchemaVersion:     manifest.SchemaVersion,
		ArtifactCreatedAt: manifest.CreatedAt,
	}, nil
}

func (u *RestoreValidationUsecase) RunRestoreTrial(ctx context.Context, operationID string) (domain.RestoreTrialState, error) {
	u.mu.Lock()
	if u.validating || u.running {
		u.mu.Unlock()
		return domain.RestoreTrialState{}, errors.New("restore validation or trial is already running")
	}
	if u.current == nil || strings.TrimSpace(operationID) == "" || operationID != u.current.operationID {
		u.mu.Unlock()
		return domain.RestoreTrialState{}, errors.New("restore validation operation is not current")
	}
	validated := *u.current
	u.running = true
	runningState := domain.RestoreTrialState{Status: domain.RestoreTrialRunning, ArtifactSHA256: validated.artifactSHA256}
	u.state = runningState
	u.mu.Unlock()
	u.recordTrialState(ctx, runningState)
	defer func() {
		u.mu.Lock()
		u.running = false
		u.mu.Unlock()
	}()

	workspaceRoot, err := u.database.ApplicationDataDirectory()
	if err != nil {
		return u.finishRestoreTrial(ctx, validated.artifactSHA256, fmt.Errorf("resolve restore trial workspace: %w", err))
	}
	trialDirectory, err := os.MkdirTemp(workspaceRoot, "restore-trial-*")
	if err != nil {
		return u.finishRestoreTrial(ctx, validated.artifactSHA256, errors.New("create isolated restore directory"))
	}
	if err := os.Chmod(trialDirectory, 0o700); err != nil {
		_ = removeManagedRestoreDirectory(workspaceRoot, trialDirectory, "restore-trial-")
		return u.finishRestoreTrial(ctx, validated.artifactSHA256, errors.New("protect isolated restore directory"))
	}
	trialErr := u.database.RunIsolatedRestoreTrial(ctx, validated.databasePath, trialDirectory, validated.manifest)
	cleanupErr := removeManagedRestoreDirectory(workspaceRoot, trialDirectory, "restore-trial-")
	if trialErr != nil {
		if cleanupErr != nil {
			trialErr = errors.Join(trialErr, fmt.Errorf("remove isolated restore database: %w", cleanupErr))
		}
		return u.finishRestoreTrial(ctx, validated.artifactSHA256, trialErr)
	}
	if cleanupErr != nil {
		return u.finishRestoreTrial(ctx, validated.artifactSHA256, &domain.RestoreValidationError{
			Code: domain.RestoreValidationComparison,
			Err:  fmt.Errorf("remove isolated restore database: %w", cleanupErr),
		})
	}
	return u.finishRestoreTrial(ctx, validated.artifactSHA256, nil)
}

func (u *RestoreValidationUsecase) RestoreTrialState() domain.RestoreTrialState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *RestoreValidationUsecase) Close() error {
	u.mu.Lock()
	if u.validating || u.running {
		u.mu.Unlock()
		return errors.New("restore validation or trial is running")
	}
	current := u.current
	u.current = nil
	u.state = domain.RestoreTrialState{Status: domain.RestoreTrialNotRun}
	u.mu.Unlock()
	if current == nil {
		return nil
	}
	workspaceRoot, err := u.database.ApplicationDataDirectory()
	if err != nil {
		return fmt.Errorf("resolve restore workspace: %w", err)
	}
	return removeManagedRestoreDirectory(workspaceRoot, current.directory, "restore-validated-")
}

func (u *RestoreValidationUsecase) finishRestoreTrial(ctx context.Context, artifactSHA string, trialErr error) (domain.RestoreTrialState, error) {
	state := domain.RestoreTrialState{
		Status:         domain.RestoreTrialPassed,
		ArtifactSHA256: artifactSHA,
		TestedAt:       u.clock.Now().UTC(),
	}
	if trialErr != nil {
		state.Status = domain.RestoreTrialFailed
		var validationErr *domain.RestoreValidationError
		if errors.As(trialErr, &validationErr) {
			state.FailureCode = validationErr.Code
		}
	}
	u.mu.Lock()
	u.state = state
	u.mu.Unlock()
	u.recordTrialState(ctx, state)
	state = u.RestoreTrialState()
	if trialErr != nil {
		return state, trialErr
	}
	return state, nil
}

func (u *RestoreValidationUsecase) recordTrialState(ctx context.Context, state domain.RestoreTrialState) {
	if u.recorder == nil {
		return
	}
	if err := u.recorder.RecordRestoreTrial(ctx, state); err != nil {
		u.mu.Lock()
		if u.state.Status == state.Status && u.state.ArtifactSHA256 == state.ArtifactSHA256 {
			u.state.Warning = appendWarning(u.state.Warning, "restore trial state record failed")
		}
		u.mu.Unlock()
	}
}

func validateManagedRestoreDirectory(root, directory, prefix string) error {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return errors.New("resolve restore workspace root")
	}
	absoluteDirectory, err := filepath.Abs(directory)
	if err != nil {
		return errors.New("resolve managed restore directory")
	}
	relative, err := filepath.Rel(absoluteRoot, absoluteDirectory)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("managed restore directory is outside the restore workspace")
	}
	if filepath.Dir(relative) != "." || !strings.HasPrefix(filepath.Base(relative), prefix) {
		return errors.New("managed restore directory does not use the fixed naming convention")
	}
	info, err := os.Lstat(absoluteDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed restore directory is unavailable")
	}
	return nil
}

func removeManagedRestoreDirectory(root, directory, prefix string) error {
	if _, err := os.Lstat(directory); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return errors.New("inspect managed restore directory")
	}
	if err := validateManagedRestoreDirectory(root, directory, prefix); err != nil {
		return err
	}
	return os.RemoveAll(directory)
}
