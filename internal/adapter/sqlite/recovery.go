package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

func RecoverPendingRestore(dataDirectory string) (domain.RestoreRecoveryResult, error) {
	paths, err := newRestorePaths(dataDirectory)
	if err != nil {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("unsafe_data_directory", "", false, false, false)
	}
	if err := validateExistingFixedRestoreFiles(paths); err != nil {
		current, original, incoming, _ := restorePresence(paths)
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("unsafe_fixed_path", "", current, original, incoming)
	}
	journalPresent, err := restoreFileExists(paths.journal)
	if err != nil {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("journal_inspection_failed", "", false, false, false)
	}
	if !journalPresent {
		return recoverWithoutJournal(paths)
	}
	journal, err := readRestoreJournal(paths.journal)
	if err != nil {
		current, original, incoming, _ := restorePresence(paths)
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("invalid_journal", "", current, original, incoming)
	}
	current, original, incoming, err := restorePresence(paths)
	if err != nil {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("file_inspection_failed", string(journal.Stage), false, false, false)
	}
	if journal.Stage == restoreStageCommitted {
		if !current || incoming {
			return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("indeterminate_committed_files", string(journal.Stage), current, original, incoming)
		}
		if err := validateCommittedRestore(context.Background(), paths.current, journal); err != nil {
			return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("committed_restore_unproven", string(journal.Stage), current, original, incoming)
		}
		if err := cleanupCommittedRestore(paths); err != nil {
			return domain.RestoreRecoveryResult{}, fmt.Errorf("clean committed restore files: %w", err)
		}
		return domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryCommittedCleaned, OperationID: journal.OperationID, ArtifactSHA256: journal.ArtifactSHA256}, nil
	}
	if original {
		if incoming && current {
			return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("indeterminate_precommit_files", string(journal.Stage), current, original, incoming)
		}
		if !incoming && !current {
			return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("missing_precommit_candidate", string(journal.Stage), current, original, incoming)
		}
		if err := rollbackRestoreFiles(paths, journal); err != nil {
			return domain.RestoreRecoveryResult{}, fmt.Errorf("roll back pending restore: %w", err)
		}
		return domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryRolledBack, OperationID: journal.OperationID, ArtifactSHA256: journal.ArtifactSHA256}, nil
	}
	if !current || !incoming {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("indeterminate_prepared_files", string(journal.Stage), current, original, incoming)
	}
	if err := cleanupUnmovedRestore(paths); err != nil {
		return domain.RestoreRecoveryResult{}, fmt.Errorf("clean unapplied restore: %w", err)
	}
	return domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryRolledBack, OperationID: journal.OperationID, ArtifactSHA256: journal.ArtifactSHA256}, nil
}

func recoverWithoutJournal(paths restorePaths) (domain.RestoreRecoveryResult, error) {
	current, original, incoming, err := restorePresence(paths)
	if err != nil {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("file_inspection_failed", "", false, false, false)
	}
	if original {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("original_without_journal", "", current, original, incoming)
	}
	if incoming && !current {
		return domain.RestoreRecoveryResult{}, safeRestoreRecoveryError("candidate_without_current", "", current, original, incoming)
	}
	for _, path := range []string{paths.journalTemporary, paths.incoming + "-wal", paths.incoming + "-shm", paths.incoming} {
		if err := removeRestoreFileIfPresent(paths.root, path); err != nil {
			return domain.RestoreRecoveryResult{}, err
		}
	}
	return domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone}, nil
}

func rollbackRestoreFiles(paths restorePaths, journal restoreJournal) error {
	current, original, incoming, err := restorePresence(paths)
	if err != nil || !original {
		return errors.New("original restore database is unavailable")
	}
	if current {
		if incoming {
			return errors.New("both current and incoming restore databases exist")
		}
		if err := moveRestoreFile(paths.root, paths.current, paths.incoming); err != nil {
			return err
		}
	}
	if err := restoreOriginalSidecar(paths, "-wal", journal.OriginalWAL, current); err != nil {
		return err
	}
	if err := restoreOriginalSidecar(paths, "-shm", journal.OriginalSHM, current); err != nil {
		return err
	}
	if err := moveRestoreFile(paths.root, paths.original, paths.current); err != nil {
		return err
	}
	// Once the original database is current again, removing the journal first
	// makes every cleanup prefix recoverable as the ordinary no-journal case.
	for _, path := range []string{paths.journal, paths.journalTemporary, paths.incoming + "-wal", paths.incoming + "-shm", paths.incoming} {
		if err := removeRestoreFileIfPresent(paths.root, path); err != nil {
			return err
		}
	}
	return nil
}

func restoreOriginalSidecar(paths restorePaths, suffix string, expected, replacementWasCurrent bool) error {
	backup := paths.original + suffix
	current := paths.current + suffix
	backupExists, err := restoreFileExists(backup)
	if err != nil {
		return err
	}
	currentExists, err := restoreFileExists(current)
	if err != nil {
		return err
	}
	if !expected {
		if backupExists {
			return errors.New("unexpected original restore sidecar")
		}
		if replacementWasCurrent && currentExists {
			return removeRestoreFileIfPresent(paths.root, current)
		}
		return nil
	}
	if backupExists {
		if currentExists {
			if err := removeRestoreFileIfPresent(paths.root, current); err != nil {
				return err
			}
		}
		return moveRestoreFile(paths.root, backup, current)
	}
	if !currentExists || replacementWasCurrent {
		return errors.New("required original restore sidecar is missing")
	}
	return nil
}

func cleanupUnmovedRestore(paths restorePaths) error {
	for _, path := range []string{paths.journal, paths.journalTemporary, paths.incoming + "-wal", paths.incoming + "-shm", paths.incoming} {
		if err := removeRestoreFileIfPresent(paths.root, path); err != nil {
			return err
		}
	}
	return nil
}

func cleanupCommittedRestore(paths restorePaths) error {
	for _, path := range []string{paths.original, paths.original + "-wal", paths.original + "-shm", paths.journalTemporary, paths.journal} {
		if err := removeRestoreFileIfPresent(paths.root, path); err != nil {
			return err
		}
	}
	return nil
}

func validateCommittedRestore(ctx context.Context, path string, journal restoreJournal) error {
	database, err := sql.Open("sqlite", sqliteReadOnlyDSN(path))
	if err != nil {
		return err
	}
	database.SetMaxOpenConns(1)
	defer database.Close()
	var integrity string
	if err := database.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("committed restore database failed integrity validation")
	}
	var schemaVersion int64
	if err := database.QueryRowContext(ctx, `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil || schemaVersion != journal.SchemaVersion {
		return errors.New("committed restore schema version is invalid")
	}
	expectedJSON, err := restoreAuditJSON(journal)
	if err != nil {
		return err
	}
	var count int
	if err := database.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM configuration_audits
		WHERE audit_id = ? AND occurred_at = ? AND actor = 'system'
		  AND action = 'restore_succeeded' AND entity_type = 'restore'
		  AND entity_id = ? AND before_json IS NULL AND after_json = ?`,
		journal.AuditID, journal.RestoredAt, journal.OperationID, expectedJSON).Scan(&count); err != nil || count != 1 {
		return errors.New("committed restore audit is missing")
	}
	return nil
}

func restoreAuditJSON(journal restoreJournal) (string, error) {
	value := struct {
		ArtifactSHA256 string `json:"artifactSha256"`
		FormatVersion  int    `json:"formatVersion"`
		SchemaVersion  int64  `json:"schemaVersion"`
		RestoredAt     string `json:"restoredAt"`
	}{
		ArtifactSHA256: journal.ArtifactSHA256,
		FormatVersion:  journal.BackupFormatVersion,
		SchemaVersion:  journal.SchemaVersion,
		RestoredAt:     journal.RestoredAt,
	}
	encoded, err := json.Marshal(value)
	return string(encoded), err
}

func safeRestoreRecoveryError(code, stage string, current, original, incoming bool) error {
	return &domain.RestoreRecoveryError{
		Code:             code,
		Stage:            stage,
		CurrentPresent:   current,
		OriginalPresent:  original,
		CandidatePresent: incoming,
	}
}
