package backupzip

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"token-monitor-analytics/internal/domain"
)

type AtomicReplacer interface {
	Replace(sourcePath, destinationPath string) error
}

type FailureInjector interface {
	Check(point string) error
}

type BackupArchiveProgress = string

const BackupArchiveProgressValidating BackupArchiveProgress = "validating"

type BackupArchiveProgressReporter = func(BackupArchiveProgress)

type Writer struct {
	replacer AtomicReplacer
	injector FailureInjector
}

func NewWriter() (*Writer, error) {
	replacer, err := newAtomicReplacer()
	if err != nil {
		return nil, err
	}
	return &Writer{replacer: replacer}, nil
}

func NewWriterWithAtomicReplacer(replacer AtomicReplacer) (*Writer, error) {
	return NewWriterWithAtomicReplacerAndFailureInjector(replacer, nil)
}

func NewWriterWithAtomicReplacerAndFailureInjector(replacer AtomicReplacer, injector FailureInjector) (*Writer, error) {
	if replacer == nil {
		return nil, errors.New("atomic replacer is required")
	}
	return &Writer{replacer: replacer, injector: injector}, nil
}

func (w *Writer) Write(ctx context.Context, destinationPath, applicationDataDir, databasePath string, protectedPaths []string, manifest domain.BackupManifest, reporter BackupArchiveProgressReporter) (domain.BackupArtifact, error) {
	if err := ctx.Err(); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := manifest.Validate(); err != nil {
		return domain.BackupArtifact{}, fmt.Errorf("validate backup manifest: %w", err)
	}
	destination, err := filepath.Abs(destinationPath)
	if err != nil {
		return domain.BackupArtifact{}, errors.New("resolve backup destination")
	}
	if err := validateDestination(destination, applicationDataDir, protectedPaths); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := inject(w.injector, "after-destination-check"); err != nil {
		return domain.BackupArtifact{}, err
	}
	metadata, err := fileMetadata(databasePath)
	if err != nil {
		return domain.BackupArtifact{}, errors.New("read temporary backup database")
	}
	if metadata.size != manifest.Database.SizeBytes || metadata.sha256 != manifest.Database.SHA256 {
		return domain.BackupArtifact{}, errors.New("temporary backup database does not match manifest")
	}
	if err := inject(w.injector, "after-database-check"); err != nil {
		return domain.BackupArtifact{}, err
	}
	destinationDirectory := filepath.Dir(destination)
	temporaryZip, err := os.CreateTemp(destinationDirectory, ".backup-*.part")
	if err != nil {
		return domain.BackupArtifact{}, errors.New("create temporary backup ZIP")
	}
	temporaryZipPath := temporaryZip.Name()
	removeTemporaryZip := true
	defer func() {
		if removeTemporaryZip {
			_ = os.Remove(temporaryZipPath)
		}
	}()
	if err := temporaryZip.Chmod(0o600); err != nil {
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("set temporary backup ZIP permissions")
	}
	manifestBytes, err := marshalManifest(manifest)
	if err != nil {
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, fmt.Errorf("encode backup manifest: %w", err)
	}
	archive := zip.NewWriter(temporaryZip)
	manifestEntry, err := archive.Create("manifest.json")
	if err != nil {
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("write backup manifest entry")
	}
	if _, err := manifestEntry.Write(manifestBytes); err != nil {
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("write backup manifest")
	}
	databaseEntry, err := archive.Create("data.sqlite3")
	if err != nil {
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("write backup database entry")
	}
	databaseFile, err := os.Open(databasePath)
	if err != nil {
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("open temporary backup database")
	}
	if _, err := io.Copy(databaseEntry, databaseFile); err != nil {
		_ = databaseFile.Close()
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("write backup database")
	}
	if err := databaseFile.Close(); err != nil {
		_ = archive.Close()
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("close temporary backup database")
	}
	if err := archive.Close(); err != nil {
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("close temporary backup ZIP archive")
	}
	if err := temporaryZip.Sync(); err != nil {
		_ = temporaryZip.Close()
		return domain.BackupArtifact{}, errors.New("flush temporary backup ZIP")
	}
	if err := temporaryZip.Close(); err != nil {
		return domain.BackupArtifact{}, errors.New("close temporary backup ZIP")
	}
	if reporter != nil {
		reporter(BackupArchiveProgressValidating)
	}
	if err := validateArchiveFile(temporaryZipPath, manifest); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := inject(w.injector, "after-archive-readback"); err != nil {
		return domain.BackupArtifact{}, err
	}
	artifactHash, artifactSize, err := fileHash(temporaryZipPath)
	if err != nil {
		return domain.BackupArtifact{}, errors.New("read temporary backup ZIP")
	}
	if err := ctx.Err(); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := inject(w.injector, "before-commit"); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := validateDestination(destination, applicationDataDir, protectedPaths); err != nil {
		return domain.BackupArtifact{}, err
	}
	if err := w.replacer.Replace(temporaryZipPath, destination); err != nil {
		return domain.BackupArtifact{}, errors.New("atomic backup replacement failed")
	}
	removeTemporaryZip = false
	artifact := domain.BackupArtifact{
		Path:           destination,
		SizeBytes:      artifactSize,
		ArtifactSHA256: artifactHash,
		CreatedAt:      manifest.CreatedAt,
	}
	if gotHash, gotSize, hashErr := fileHash(destination); hashErr != nil || gotHash != artifactHash || gotSize != artifactSize {
		artifact.Warning = "committed backup readback failed"
	}
	return artifact, nil
}

func inject(injector FailureInjector, point string) error {
	if injector == nil {
		return nil
	}
	if err := injector.Check(point); err != nil {
		return fmt.Errorf("injected backup failure at %s: %w", point, err)
	}
	return nil
}

type fileMetadataResult struct {
	size   int64
	sha256 string
}

func fileMetadata(path string) (fileMetadataResult, error) {
	hash, size, err := fileHash(path)
	if err != nil {
		return fileMetadataResult{}, err
	}
	if size <= 0 {
		return fileMetadataResult{}, errors.New("file is empty")
	}
	return fileMetadataResult{size: size, sha256: hash}, nil
}

func fileHash(path string) (hash string, size int64, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	hasher := sha256.New()
	size, err = io.Copy(hasher, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hasher.Sum(nil)), size, nil
}

func validateArchiveFile(path string, expected domain.BackupManifest) (err error) {
	const maxManifestSize = 64 * 1024

	file, err := os.Open(path)
	if err != nil {
		return errors.New("open temporary backup ZIP for readback")
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return errors.New("temporary backup ZIP is empty")
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil {
		return errors.New("read temporary backup ZIP structure")
	}
	if len(reader.File) != 2 {
		return errors.New("backup ZIP must contain exactly two entries")
	}
	seen := make(map[string]struct{}, len(reader.File))
	var manifestBytes []byte
	var databaseHash string
	var databaseSize int64
	for _, entry := range reader.File {
		if entry.Name != "manifest.json" && entry.Name != "data.sqlite3" {
			return errors.New("backup ZIP contains an unexpected entry")
		}
		if _, exists := seen[entry.Name]; exists {
			return errors.New("backup ZIP contains duplicate entries")
		}
		seen[entry.Name] = struct{}{}
		entryReader, err := entry.Open()
		if err != nil {
			return errors.New("open backup ZIP entry")
		}
		if entry.Name == "manifest.json" {
			if entry.UncompressedSize64 > maxManifestSize {
				_ = entryReader.Close()
				return errors.New("backup ZIP manifest entry is too large")
			}
			contents, readErr := io.ReadAll(io.LimitReader(entryReader, maxManifestSize+1))
			closeErr := entryReader.Close()
			if readErr != nil || closeErr != nil {
				return errors.New("read backup ZIP entry")
			}
			if len(contents) > maxManifestSize {
				return errors.New("backup ZIP manifest entry is too large")
			}
			manifestBytes = contents
		} else {
			if entry.UncompressedSize64 != uint64(expected.Database.SizeBytes) {
				_ = entryReader.Close()
				return errors.New("backup ZIP database entry size is invalid")
			}
			hasher := sha256.New()
			readSize, copyErr := io.Copy(hasher, io.LimitReader(entryReader, expected.Database.SizeBytes+1))
			closeErr := entryReader.Close()
			if copyErr != nil || closeErr != nil {
				return errors.New("hash backup ZIP database entry")
			}
			databaseSize = readSize
			databaseHash = hex.EncodeToString(hasher.Sum(nil))
		}
	}
	if len(seen) != 2 {
		return errors.New("backup ZIP is missing an entry")
	}
	gotManifest, err := parseManifest(manifestBytes)
	if err != nil {
		return fmt.Errorf("validate readback manifest: %w", err)
	}
	if !sameManifest(gotManifest, expected) {
		return errors.New("readback manifest changed")
	}
	if databaseSize != expected.Database.SizeBytes {
		return errors.New("readback database size changed")
	}
	if databaseHash != expected.Database.SHA256 {
		return errors.New("readback database sha256 changed")
	}
	return nil
}

func sameManifest(left, right domain.BackupManifest) bool {
	return left.FormatVersion == right.FormatVersion &&
		left.SchemaVersion == right.SchemaVersion &&
		left.AppVersion == right.AppVersion &&
		left.CreatedAt.UTC().Format(time.RFC3339Nano) == right.CreatedAt.UTC().Format(time.RFC3339Nano) &&
		left.Database.Path == right.Database.Path &&
		left.Database.SizeBytes == right.Database.SizeBytes &&
		left.Database.SHA256 == right.Database.SHA256
}
