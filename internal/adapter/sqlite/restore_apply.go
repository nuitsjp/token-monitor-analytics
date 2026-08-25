package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

type RestoreFailureInjector interface {
	Check(string) error
}

type RestoreApplier struct {
	lifecycle *Lifecycle
	injector  RestoreFailureInjector
}

func NewRestoreApplier(lifecycle *Lifecycle, injector RestoreFailureInjector) (*RestoreApplier, error) {
	if lifecycle == nil {
		return nil, errors.New("restore lifecycle is required")
	}
	return &RestoreApplier{lifecycle: lifecycle, injector: injector}, nil
}

func (a *RestoreApplier) ApplyValidatedRestore(ctx context.Context, candidatePath, operationID, artifactSHA string, manifest domain.BackupManifest, auditID string, restoredAt time.Time) (domain.RestoreApplyResult, error) {
	result := domain.RestoreApplyResult{
		OperationID: operationID, ArtifactSHA256: artifactSHA,
		FormatVersion: manifest.FormatVersion, SchemaVersion: manifest.SchemaVersion,
		RestoredAt: restoredAt.UTC(), AuditID: auditID, RollbackSucceeded: true,
	}
	if err := validateRestoreApplyRequest(operationID, artifactSHA, auditID, restoredAt, manifest); err != nil {
		return result, err
	}
	dataDirectory, err := a.lifecycle.ApplicationDataDirectory()
	if err != nil {
		return result, err
	}
	paths, err := newRestorePaths(dataDirectory)
	if err != nil {
		return result, err
	}
	candidatePath, err = validateRestoreCandidatePath(paths, candidatePath)
	if err != nil {
		return result, err
	}
	if err := ensureRestoreWorkspaceClean(paths); err != nil {
		return result, err
	}
	// Re-run the complete semantic, size, and digest validation immediately
	// before application. The operation ID never authorizes a path alone.
	if err := a.lifecycle.ValidateRestoreDatabase(ctx, candidatePath, manifest); err != nil {
		return result, err
	}
	if err := a.fail("validated"); err != nil {
		return result, err
	}

	a.lifecycle.mu.Lock()
	defer a.lifecycle.mu.Unlock()
	if a.lifecycle.database == nil || filepath.Clean(a.lifecycle.databasePath) != filepath.Clean(paths.current) {
		return result, errors.New("operational database does not use the fixed restore path")
	}
	if err := validateRestoreRegularFile(paths.current); err != nil {
		return result, err
	}
	if err := checkpointRestoreDatabase(ctx, a.lifecycle.database); err != nil {
		return result, err
	}
	if err := a.fail("checkpointed"); err != nil {
		return result, err
	}
	if err := a.lifecycle.database.Close(); err != nil {
		return result, fmt.Errorf("close operational database for restore: %w", err)
	}
	a.lifecycle.database = nil
	if err := a.fail("closed"); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := moveRestoreFile(paths.root, candidatePath, paths.incoming); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := syncRestoreFile(paths.incoming); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := a.fail("candidate_staged"); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := a.lifecycle.validateRestoreDatabase(ctx, paths.incoming, manifest, false); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	sourceSnapshot, err := logicalSnapshot(ctx, paths.incoming)
	if err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, fmt.Errorf("snapshot staged restore candidate: %w", err))
	}

	journal := restoreJournal{
		JournalVersion: restoreJournalVersion, Stage: restoreStagePrepared,
		OperationID: operationID, ArtifactSHA256: artifactSHA,
		BackupFormatVersion: manifest.FormatVersion, SchemaVersion: manifest.SchemaVersion,
		RestoredAt: restoredAt.UTC().Format(time.RFC3339Nano), AuditID: auditID,
	}
	journal.OriginalWAL, err = restoreFileExists(paths.current + "-wal")
	if err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	journal.OriginalSHM, err = restoreFileExists(paths.current + "-shm")
	if err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := a.fail("journal_prepared"); err != nil {
		return a.rollbackBeforeOriginal(ctx, paths, result, err)
	}
	if err := ctx.Err(); err != nil {
		return a.rollbackBeforeOriginal(context.WithoutCancel(ctx), paths, result, err)
	}
	durableContext := context.WithoutCancel(ctx)

	if err := moveRestoreFile(paths.root, paths.current, paths.original); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("original_database_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if journal.OriginalWAL {
		if err := moveRestoreFile(paths.root, paths.current+"-wal", paths.original+"-wal"); err != nil {
			return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
		}
	}
	if err := a.fail("original_wal_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if journal.OriginalSHM {
		if err := moveRestoreFile(paths.root, paths.current+"-shm", paths.original+"-shm"); err != nil {
			return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
		}
	}
	if err := a.fail("original_shm_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	journal.Stage = restoreStageOriginalMoved
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("journal_original_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}

	if err := moveRestoreFile(paths.root, paths.incoming, paths.current); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("replacement_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	journal.Stage = restoreStageReplacementMoved
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("journal_replacement_moved"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}

	if err := a.lifecycle.validateRestoreDatabase(durableContext, paths.current, manifest, false); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("replacement_validated"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	absolutePath, database, err := openLifecycleDatabase(durableContext, paths.current)
	if err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	a.lifecycle.database, a.lifecycle.databasePath = database, absolutePath
	journal.Stage = restoreStageReopened
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("reopened"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}

	if err := appendRestoreAudit(durableContext, database, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("audit_written"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	journal.Stage = restoreStageAuditWritten
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("journal_audit_written"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := checkpointRestoreDatabase(durableContext, database); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}

	targetSnapshot, err := logicalSnapshotDatabase(durableContext, database, auditID)
	if err != nil || !reflect.DeepEqual(sourceSnapshot, targetSnapshot) {
		if err == nil {
			err = errors.New("restored logical contents differ from validated candidate")
		}
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := validateCommittedRestore(durableContext, paths.current, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("contents_verified"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	journal.Stage = restoreStageVerified
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	if err := a.fail("verified"); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	journal.Stage = restoreStageCommitted
	if err := writeRestoreJournal(paths, journal); err != nil {
		return a.rollbackAfterOriginal(durableContext, paths, journal, result, err)
	}
	result.RollbackSucceeded = false
	if err := a.fail("committed"); err != nil {
		result.Warning = "restore committed; startup cleanup is required"
		return result, nil
	}
	if err := cleanupCommittedRestore(paths); err != nil {
		result.Warning = "restore committed; startup cleanup is required"
		return result, nil
	}
	return result, nil
}

func validateRestoreApplyRequest(operationID, artifactSHA, auditID string, restoredAt time.Time, manifest domain.BackupManifest) error {
	if !restoreJournalToken.MatchString(operationID) || !restoreJournalToken.MatchString(auditID) {
		return errors.New("restore identifiers are invalid")
	}
	if !restoreJournalSHA.MatchString(artifactSHA) {
		return errors.New("restore artifact SHA-256 is invalid")
	}
	if restoredAt.IsZero() || restoredAt.Location() != time.UTC || !strings.HasSuffix(restoredAt.Format(time.RFC3339Nano), "Z") {
		return errors.New("restore time must be UTC")
	}
	return manifest.Validate()
}

func checkpointRestoreDatabase(ctx context.Context, database *sql.DB) error {
	var busy, logFrames, checkpointed int
	if err := database.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(&busy, &logFrames, &checkpointed); err != nil {
		return fmt.Errorf("checkpoint restore database: %w", err)
	}
	if busy != 0 {
		return errors.New("checkpoint restore database remained busy")
	}
	return nil
}

func appendRestoreAudit(ctx context.Context, database *sql.DB, journal restoreJournal) error {
	afterJSON, err := restoreAuditJSON(journal)
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin restore audit: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO configuration_audits
			(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
		VALUES (?, ?, 'system', 'restore_succeeded', 'restore', ?, NULL, ?)`,
		journal.AuditID, journal.RestoredAt, journal.OperationID, afterJSON); err != nil {
		return fmt.Errorf("append restore audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit restore audit: %w", err)
	}
	return nil
}

func (a *RestoreApplier) rollbackBeforeOriginal(ctx context.Context, paths restorePaths, result domain.RestoreApplyResult, applyErr error) (domain.RestoreApplyResult, error) {
	cleanupErr := cleanupUnmovedRestore(paths)
	reopenErr := a.reopenOriginal(ctx, paths.current)
	result.RollbackSucceeded = cleanupErr == nil && reopenErr == nil
	return result, errors.Join(applyErr, cleanupErr, reopenErr)
}

func (a *RestoreApplier) rollbackAfterOriginal(ctx context.Context, paths restorePaths, journal restoreJournal, result domain.RestoreApplyResult, applyErr error) (domain.RestoreApplyResult, error) {
	var closeErr error
	if a.lifecycle.database != nil {
		closeErr = a.lifecycle.database.Close()
		a.lifecycle.database = nil
	}
	rollbackErr := rollbackRestoreFiles(paths, journal)
	var reopenErr error
	if rollbackErr == nil {
		reopenErr = a.reopenOriginal(ctx, paths.current)
	}
	result.RollbackSucceeded = closeErr == nil && rollbackErr == nil && reopenErr == nil
	return result, errors.Join(applyErr, closeErr, rollbackErr, reopenErr)
}

func (a *RestoreApplier) reopenOriginal(ctx context.Context, path string) error {
	absolutePath, database, err := openLifecycleDatabase(ctx, path)
	if err != nil {
		return fmt.Errorf("reopen original database: %w", err)
	}
	a.lifecycle.database, a.lifecycle.databasePath = database, absolutePath
	return nil
}

func (a *RestoreApplier) fail(point string) error {
	if a.injector == nil {
		return nil
	}
	return a.injector.Check(point)
}
