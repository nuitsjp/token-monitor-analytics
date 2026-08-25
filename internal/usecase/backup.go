package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"token-monitor-analytics/internal/domain"
)

type BackupSource interface {
	ApplicationDataDirectory() (string, error)
	DatabasePath() (string, error)
	ProtectedBackupPaths() ([]string, error)
	SchemaVersion() int64
	Backup(context.Context, string) error
	ValidateBackupDatabase(context.Context, string) error
}

type BackupArchiveWriter interface {
	Write(context.Context, string, string, string, []string, domain.BackupManifest) (domain.BackupArtifact, error)
}

type BackupResultRecorder interface {
	RecordBackup(context.Context, domain.BackupArtifact) error
}

type BackupUsecase struct {
	source   BackupSource
	writer   BackupArchiveWriter
	recorder BackupResultRecorder
	clock    Clock
	appVer   string
	gate     *MaintenanceGate
}

func NewBackupUsecase(source BackupSource, writer BackupArchiveWriter, recorder BackupResultRecorder, clock Clock, appVersion string, gate *MaintenanceGate) (*BackupUsecase, error) {
	if source == nil || writer == nil || clock == nil || gate == nil {
		return nil, errors.New("backup usecase dependencies are required")
	}
	if strings.TrimSpace(appVersion) == "" {
		return nil, errors.New("backup app version is required")
	}
	return &BackupUsecase{source: source, writer: writer, recorder: recorder, clock: clock, appVer: appVersion, gate: gate}, nil
}

func (u *BackupUsecase) CreateBackup(ctx context.Context, destinationPath string) (domain.BackupArtifact, error) {
	if strings.TrimSpace(destinationPath) == "" {
		return domain.BackupArtifact{}, errors.New("backup destination is required")
	}
	lease, err := u.gate.Acquire(ctx, MaintenanceBackup)
	if err != nil {
		return domain.BackupArtifact{}, err
	}
	defer lease.Release()
	dataDir, err := u.source.ApplicationDataDirectory()
	if err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("resolve application data directory: %w", err)
	}
	databasePath, err := u.source.DatabasePath()
	if err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("resolve database path: %w", err)
	}
	protectedPaths, err := u.source.ProtectedBackupPaths()
	if err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("resolve protected backup paths: %w", err)
	}
	temporaryDatabase, err := createTemporaryDatabasePath(dataDir)
	if err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("create temporary backup database path: %w", err)
	}
	cleanupErr := func() error {
		return removeTemporaryDatabase(temporaryDatabase)
	}
	defer func() { _ = cleanupErr() }()
	protectedPaths = append(protectedPaths,
		databasePath, databasePath+"-wal", databasePath+"-shm",
		temporaryDatabase, temporaryDatabase+"-wal", temporaryDatabase+"-shm",
	)

	if err := u.source.Backup(ctx, temporaryDatabase); err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("create online backup: %w", err)
	}
	if err := u.source.ValidateBackupDatabase(ctx, temporaryDatabase); err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("validate temporary backup database: %w", err)
	}
	metadata, err := backupFileMetadata(temporaryDatabase)
	if err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("read temporary backup database: %w", err)
	}
	createdAt := u.clock.Now().UTC()
	manifest := domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: u.source.SchemaVersion(),
		AppVersion:    u.appVer,
		CreatedAt:     createdAt,
		Database: domain.BackupDatabaseManifest{
			Path:      "data.sqlite3",
			SizeBytes: metadata.size,
			SHA256:    metadata.sha256,
		},
	}
	if err := manifest.Validate(); err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("build backup manifest: %w", err)
	}
	artifact, err := u.writer.Write(ctx, destinationPath, dataDir, temporaryDatabase, protectedPaths, manifest)
	if err != nil {
		return domain.BackupArtifact{}, err
	}
	if cleanupErr := cleanupErr(); cleanupErr != nil {
		artifact.Warning = appendWarning(artifact.Warning, "temporary backup cleanup failed")
	}
	if u.recorder != nil {
		if u.recorder.RecordBackup(ctx, artifact) != nil {
			artifact.Warning = appendWarning(artifact.Warning, "backup result record failed")
		}
	}
	return artifact, nil
}

type backupFileMetadataResult struct {
	size   int64
	sha256 string
}

func backupFileMetadata(path string) (backupFileMetadataResult, error) {
	file, err := os.Open(path)
	if err != nil {
		return backupFileMetadataResult{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return backupFileMetadataResult{}, err
	}
	if info.Size() <= 0 {
		return backupFileMetadataResult{}, errors.New("temporary backup database is empty")
	}
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return backupFileMetadataResult{}, err
	}
	return backupFileMetadataResult{size: info.Size(), sha256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

func createTemporaryDatabasePath(dataDir string) (string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return "", errors.New("application data directory is empty")
	}
	file, err := os.CreateTemp(dataDir, "backup-temp-*.sqlite3")
	if err != nil {
		return "", err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	if err := os.Remove(path); err != nil {
		return "", err
	}
	return path, nil
}

func removeTemporaryDatabase(path string) error {
	var errs []error
	for _, candidate := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func appendWarning(current, next string) string {
	if current == "" {
		return next
	}
	return current + "; " + next
}
