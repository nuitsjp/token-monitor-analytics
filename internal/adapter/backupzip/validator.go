package backupzip

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"token-monitor-analytics/internal/domain"
)

const maxRestoreManifestSize = 64 * 1024

type Validator struct {
	availableSpace func(string) (uint64, error)
}

func NewValidator() *Validator { return &Validator{availableSpace: freeSpace} }

// ValidateAndExtract validates one artifact and extracts its database into a
// newly-created directory below workspaceRoot. The caller owns that directory
// after success. Failure always removes it.
func (v *Validator) ValidateAndExtract(ctx context.Context, archivePath, workspaceRoot string, supportedSchemaVersion int64) (domain.BackupManifest, string, string, error) {
	if err := ctx.Err(); err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	if strings.TrimSpace(archivePath) == "" {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("restore archive path is required"))
	}
	if supportedSchemaVersion <= 0 {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationSchemaVersion, errors.New("supported schema version must be positive"))
	}
	workspace, err := prepareWorkspaceRoot(workspaceRoot)
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, err)
	}
	archive, err := os.Open(archivePath)
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("open restore archive"))
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil || info.Size() <= 0 {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("restore archive is empty"))
	}
	artifactSHA, err := hashReader(ctx, archive)
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, fmt.Errorf("hash restore archive: %w", err))
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("rewind restore archive"))
	}
	reader, err := zip.NewReader(archive, info.Size())
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("read restore ZIP structure"))
	}
	manifestEntry, databaseEntry, err := restoreEntries(reader.File)
	if err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	manifestBytes, err := readManifestEntry(ctx, manifestEntry)
	if err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	if err := validateManifestKeySet(manifestBytes); err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	manifest, err := parseManifest(manifestBytes)
	if err != nil {
		return domain.BackupManifest{}, "", "", classifyManifestError(manifestBytes, err)
	}
	if manifest.FormatVersion != domain.BackupFormatVersion {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationFormatVersion, fmt.Errorf("unsupported backup format version %d", manifest.FormatVersion))
	}
	if manifest.SchemaVersion != supportedSchemaVersion {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationSchemaVersion, fmt.Errorf("unsupported backup schema version %d", manifest.SchemaVersion))
	}
	if databaseEntry.UncompressedSize64 != uint64(manifest.Database.SizeBytes) {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationDeclaredSize, errors.New("database entry size does not match manifest"))
	}
	directory, err := os.MkdirTemp(workspace, "restore-validated-*")
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("create restore validation directory"))
	}
	removeDirectory := true
	defer func() {
		if removeDirectory {
			_ = os.RemoveAll(directory)
		}
	}()
	if err := os.Chmod(directory, 0o700); err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("protect restore validation directory"))
	}
	available, err := v.availableSpace(directory)
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationFreeSpace, errors.New("inspect restore validation free space"))
	}
	if uint64(manifest.Database.SizeBytes) > available {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationFreeSpace, errors.New("insufficient space for restore validation database"))
	}
	databasePath := filepath.Join(directory, "data.sqlite3")
	if err := extractDatabase(ctx, databaseEntry, databasePath, manifest.Database.SizeBytes, manifest.Database.SHA256); err != nil {
		return domain.BackupManifest{}, "", "", err
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("rewind restore archive after validation"))
	}
	stableArtifactSHA, err := hashReader(ctx, archive)
	if err != nil {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, fmt.Errorf("rehash restore archive: %w", err))
	}
	if stableArtifactSHA != artifactSHA {
		return domain.BackupManifest{}, "", "", validationError(domain.RestoreValidationArchive, errors.New("restore archive changed during validation"))
	}
	removeDirectory = false
	return manifest, artifactSHA, directory, nil
}

func validateManifestKeySet(data []byte) error {
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		return validationError(domain.RestoreValidationManifestBOM, errors.New("restore manifest must not contain a UTF-8 BOM"))
	}
	if !utf8.Valid(data) {
		return validationError(domain.RestoreValidationManifestJSON, errors.New("restore manifest must be valid UTF-8"))
	}
	if err := scanJSONKeys(data); err != nil {
		if strings.Contains(err.Error(), "duplicate object key") {
			return validationError(domain.RestoreValidationManifestKey, err)
		}
		return validationError(domain.RestoreValidationManifestJSON, err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return validationError(domain.RestoreValidationManifestJSON, errors.New("restore manifest root must be an object"))
	}
	if err := exactKeys(top, "formatVersion", "schemaVersion", "appVersion", "createdAt", "database"); err != nil {
		return validationError(domain.RestoreValidationManifestKey, err)
	}
	var database map[string]json.RawMessage
	if err := json.Unmarshal(top["database"], &database); err != nil || database == nil {
		return validationError(domain.RestoreValidationManifestJSON, errors.New("restore manifest database must be an object"))
	}
	if err := exactKeys(database, "path", "sizeBytes", "sha256"); err != nil {
		return validationError(domain.RestoreValidationManifestKey, err)
	}
	return nil
}

func exactKeys(values map[string]json.RawMessage, required ...string) error {
	wanted := make(map[string]struct{}, len(required))
	for _, key := range required {
		wanted[key] = struct{}{}
		if _, exists := values[key]; !exists {
			return fmt.Errorf("restore manifest is missing key %q", key)
		}
	}
	for key := range values {
		if _, exists := wanted[key]; !exists {
			return fmt.Errorf("restore manifest contains unknown key %q", key)
		}
	}
	return nil
}

func prepareWorkspaceRoot(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("restore workspace root is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", errors.New("resolve restore workspace root")
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return "", errors.New("restore workspace root is unavailable")
	}
	if err := rejectReparsePath(absolute); err != nil {
		return "", errors.New("restore workspace root contains a reparse point")
	}
	return absolute, nil
}

func restoreEntries(entries []*zip.File) (*zip.File, *zip.File, error) {
	seen := make(map[string]struct{}, len(entries))
	var manifestEntry, databaseEntry *zip.File
	for _, entry := range entries {
		if entry.FileInfo().IsDir() || filepath.IsAbs(entry.Name) || strings.Contains(entry.Name, "\\") {
			return nil, nil, validationError(domain.RestoreValidationZIPEntry, errors.New("restore ZIP contains an invalid entry path"))
		}
		clean := filepath.ToSlash(filepath.Clean(entry.Name))
		if clean != entry.Name || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			return nil, nil, validationError(domain.RestoreValidationZIPEntry, errors.New("restore ZIP entry escapes the archive root"))
		}
		if _, exists := seen[entry.Name]; exists {
			return nil, nil, validationError(domain.RestoreValidationZIPEntry, errors.New("restore ZIP contains duplicate entries"))
		}
		seen[entry.Name] = struct{}{}
		switch entry.Name {
		case "manifest.json":
			manifestEntry = entry
		case "data.sqlite3":
			databaseEntry = entry
		default:
			return nil, nil, validationError(domain.RestoreValidationZIPEntry, errors.New("restore ZIP contains an unexpected entry"))
		}
	}
	if manifestEntry == nil || databaseEntry == nil || len(entries) != 2 {
		return nil, nil, validationError(domain.RestoreValidationZIPEntry, errors.New("restore ZIP must contain manifest.json and data.sqlite3 exactly once"))
	}
	return manifestEntry, databaseEntry, nil
}

func readManifestEntry(ctx context.Context, entry *zip.File) ([]byte, error) {
	if entry.UncompressedSize64 > maxRestoreManifestSize {
		return nil, validationError(domain.RestoreValidationManifestJSON, errors.New("restore manifest is too large"))
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, validationError(domain.RestoreValidationArchive, errors.New("open restore manifest"))
	}
	contents, readErr := io.ReadAll(io.LimitReader(&contextReader{ctx: ctx, reader: reader}, maxRestoreManifestSize+1))
	closeErr := reader.Close()
	if readErr != nil {
		if errors.Is(readErr, zip.ErrChecksum) {
			return nil, validationError(domain.RestoreValidationZIPCRC, errors.New("restore manifest CRC is invalid"))
		}
		return nil, validationError(domain.RestoreValidationArchive, fmt.Errorf("read restore manifest: %w", readErr))
	}
	if closeErr != nil {
		return nil, validationError(domain.RestoreValidationZIPCRC, errors.New("close restore manifest after CRC validation"))
	}
	if len(contents) > maxRestoreManifestSize {
		return nil, validationError(domain.RestoreValidationManifestJSON, errors.New("restore manifest is too large"))
	}
	return contents, nil
}

func extractDatabase(ctx context.Context, entry *zip.File, destination string, declaredSize int64, expectedSHA string) error {
	reader, err := entry.Open()
	if err != nil {
		return validationError(domain.RestoreValidationArchive, errors.New("open restore database entry"))
	}
	file, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		_ = reader.Close()
		return validationError(domain.RestoreValidationArchive, errors.New("create restore validation database"))
	}
	hasher := sha256.New()
	limited := io.LimitReader(&contextReader{ctx: ctx, reader: reader}, declaredSize+1)
	written, copyErr := io.Copy(io.MultiWriter(file, hasher), limited)
	syncErr := file.Sync()
	fileCloseErr := file.Close()
	readerCloseErr := reader.Close()
	if copyErr != nil {
		if errors.Is(copyErr, zip.ErrChecksum) {
			return validationError(domain.RestoreValidationZIPCRC, errors.New("restore database CRC is invalid"))
		}
		return validationError(domain.RestoreValidationArchive, fmt.Errorf("read restore database entry: %w", copyErr))
	}
	if readerCloseErr != nil {
		return validationError(domain.RestoreValidationZIPCRC, errors.New("close restore database after CRC validation"))
	}
	if written != declaredSize {
		return validationError(domain.RestoreValidationDeclaredSize, errors.New("restore database size does not match manifest"))
	}
	if syncErr != nil || fileCloseErr != nil {
		return validationError(domain.RestoreValidationArchive, errors.New("flush restore validation database"))
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != expectedSHA {
		return validationError(domain.RestoreValidationDatabaseSHA, errors.New("restore database SHA-256 does not match manifest"))
	}
	return nil
}

func hashReader(ctx context.Context, reader io.Reader) (string, error) {
	hasher := sha256.New()
	if _, err := io.Copy(hasher, &contextReader{ctx: ctx, reader: reader}); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func classifyManifestError(data []byte, err error) error {
	message := err.Error()
	switch {
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		return validationError(domain.RestoreValidationManifestBOM, errors.New("restore manifest must not contain a UTF-8 BOM"))
	case strings.Contains(message, "unknown field"), strings.Contains(message, "duplicate object key"),
		strings.Contains(message, "is required"), strings.Contains(message, "must be data.sqlite3"):
		return validationError(domain.RestoreValidationManifestKey, err)
	case strings.Contains(message, "unsupported backup format version"):
		return validationError(domain.RestoreValidationFormatVersion, err)
	default:
		return validationError(domain.RestoreValidationManifestJSON, err)
	}
}

func validationError(code domain.RestoreValidationCode, err error) error {
	return &domain.RestoreValidationError{Code: code, Err: err}
}
