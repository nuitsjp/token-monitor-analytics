package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const BackupFormatVersion = 1

type BackupDatabaseManifest struct {
	Path      string
	SizeBytes int64
	SHA256    string
}

type BackupManifest struct {
	FormatVersion int
	SchemaVersion int64
	AppVersion    string
	CreatedAt     time.Time
	Database      BackupDatabaseManifest
}

type BackupArtifact struct {
	Path           string
	SizeBytes      int64
	ArtifactSHA256 string
	CreatedAt      time.Time
	Warning        string
}

type RestoreValidationCode string

const (
	RestoreValidationArchive        RestoreValidationCode = "archive"
	RestoreValidationZIPEntry       RestoreValidationCode = "zip_entry"
	RestoreValidationZIPCRC         RestoreValidationCode = "zip_crc"
	RestoreValidationManifestBOM    RestoreValidationCode = "manifest_bom"
	RestoreValidationManifestJSON   RestoreValidationCode = "manifest_json"
	RestoreValidationManifestKey    RestoreValidationCode = "manifest_key"
	RestoreValidationFormatVersion  RestoreValidationCode = "format_version"
	RestoreValidationSchemaVersion  RestoreValidationCode = "schema_version"
	RestoreValidationDeclaredSize   RestoreValidationCode = "declared_size"
	RestoreValidationFreeSpace      RestoreValidationCode = "free_space"
	RestoreValidationDatabaseSHA    RestoreValidationCode = "database_sha256"
	RestoreValidationIntegrity      RestoreValidationCode = "integrity"
	RestoreValidationRequiredSchema RestoreValidationCode = "required_schema"
	RestoreValidationEnum           RestoreValidationCode = "enum"
	RestoreValidationDatetime       RestoreValidationCode = "datetime"
	RestoreValidationForeignKey     RestoreValidationCode = "foreign_key"
	RestoreValidationInterval       RestoreValidationCode = "interval_overlap"
	RestoreValidationSecret         RestoreValidationCode = "secret"
	RestoreValidationRecalculation  RestoreValidationCode = "recalculation"
	RestoreValidationComparison     RestoreValidationCode = "logical_comparison"
)

type RestoreValidationError struct {
	Code RestoreValidationCode
	Err  error
}

func (e *RestoreValidationError) Error() string {
	if e == nil || e.Err == nil {
		return "restore validation failed"
	}
	return e.Err.Error()
}

func (e *RestoreValidationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

type RestoreValidationResult struct {
	OperationID       string
	ArtifactSHA256    string
	FormatVersion     int
	SchemaVersion     int64
	ArtifactCreatedAt time.Time
}

type RestoreTrialStatus string

const (
	RestoreTrialNotRun  RestoreTrialStatus = "not_run"
	RestoreTrialRunning RestoreTrialStatus = "running"
	RestoreTrialPassed  RestoreTrialStatus = "passed"
	RestoreTrialFailed  RestoreTrialStatus = "failed"
)

type RestoreTrialState struct {
	Status         RestoreTrialStatus
	ArtifactSHA256 string
	TestedAt       time.Time
	FailureCode    RestoreValidationCode
	Warning        string
}

type RestoreApplyResult struct {
	OperationID       string
	ArtifactSHA256    string
	FormatVersion     int
	SchemaVersion     int64
	RestoredAt        time.Time
	AuditID           string
	RollbackSucceeded bool
	Warning           string
}

type RestoreRecoveryStatus string

const (
	RestoreRecoveryNone             RestoreRecoveryStatus = "none"
	RestoreRecoveryRolledBack       RestoreRecoveryStatus = "rolled_back"
	RestoreRecoveryCommittedCleaned RestoreRecoveryStatus = "committed_cleaned"
)

type RestoreRecoveryResult struct {
	Status         RestoreRecoveryStatus
	OperationID    string
	ArtifactSHA256 string
}

type RestoreRecoveryError struct {
	Code             string
	Stage            string
	CurrentPresent   bool
	OriginalPresent  bool
	CandidatePresent bool
}

func (e *RestoreRecoveryError) Error() string {
	if e == nil {
		return "restore recovery stopped safely"
	}
	return fmt.Sprintf("restore recovery stopped safely: code=%s stage=%s current=%t original=%t candidate=%t", e.Code, e.Stage, e.CurrentPresent, e.OriginalPresent, e.CandidatePresent)
}

func (m BackupManifest) Validate() error {
	if m.FormatVersion != BackupFormatVersion {
		return fmt.Errorf("unsupported backup format version %d", m.FormatVersion)
	}
	if m.SchemaVersion <= 0 {
		return errors.New("backup schema version must be positive")
	}
	if strings.TrimSpace(m.AppVersion) == "" {
		return errors.New("backup app version is required")
	}
	if m.CreatedAt.IsZero() || m.CreatedAt.Location() != time.UTC || !strings.HasSuffix(m.CreatedAt.Format(time.RFC3339Nano), "Z") {
		return errors.New("backup createdAt must be a UTC timestamp")
	}
	if m.Database.Path != "data.sqlite3" {
		return errors.New("backup database path must be data.sqlite3")
	}
	if m.Database.SizeBytes <= 0 {
		return errors.New("backup database size must be positive")
	}
	if !sha256Pattern.MatchString(m.Database.SHA256) {
		return errors.New("backup database sha256 must be 64 lowercase hexadecimal characters")
	}
	return nil
}

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
