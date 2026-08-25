package backupzip

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"token-monitor-analytics/internal/domain"
)

type restoreTestEntry struct {
	name   string
	body   []byte
	method uint16
}

func TestRestoreValidatorExtractsOnlyValidatedDatabase(t *testing.T) {
	root := t.TempDir()
	database := []byte("isolated database bytes")
	manifest := restoreTestManifest(database, 1, 13)
	archivePath := writeRestoreTestZIP(t, root, []restoreTestEntry{
		{name: "manifest.json", body: manifest},
		{name: "data.sqlite3", body: database},
	})
	validator := NewValidator()
	gotManifest, artifactSHA, directory, err := validator.ValidateAndExtract(context.Background(), archivePath, root, 13)
	if err != nil {
		t.Fatalf("validate restore archive: %v", err)
	}
	if filepath.Dir(directory) != root || !strings.HasPrefix(filepath.Base(directory), "restore-validated-") {
		t.Fatalf("validation directory = %q", directory)
	}
	extracted, err := os.ReadFile(filepath.Join(directory, "data.sqlite3"))
	if err != nil {
		t.Fatalf("read extracted database: %v", err)
	}
	if !bytes.Equal(extracted, database) || gotManifest.SchemaVersion != 13 {
		t.Fatalf("extracted database or manifest changed")
	}
	archiveBytes, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	expectedArtifactHash := sha256.Sum256(archiveBytes)
	if artifactSHA != hex.EncodeToString(expectedArtifactHash[:]) {
		t.Fatalf("artifact SHA = %q", artifactSHA)
	}
}

func TestRestoreValidatorRejectsManifestFailuresIndividually(t *testing.T) {
	database := []byte("database")
	valid := string(restoreTestManifest(database, 1, 13))
	tests := []struct {
		name string
		body []byte
		code domain.RestoreValidationCode
	}{
		{name: "BOM", body: append([]byte{0xEF, 0xBB, 0xBF}, []byte(valid)...), code: domain.RestoreValidationManifestBOM},
		{name: "invalid UTF-8", body: bytes.Replace([]byte(valid), []byte("test"), []byte{0xff}, 1), code: domain.RestoreValidationManifestJSON},
		{name: "unknown key", body: []byte(strings.Replace(valid, `"database":`, `"unknown":1,"database":`, 1)), code: domain.RestoreValidationManifestKey},
		{name: "duplicate key", body: []byte(strings.Replace(valid, `"formatVersion":1`, `"formatVersion":1,"formatVersion":1`, 1)), code: domain.RestoreValidationManifestKey},
		{name: "missing key", body: []byte(strings.Replace(valid, `"appVersion":"test",`, "", 1)), code: domain.RestoreValidationManifestKey},
		{name: "extra database key", body: []byte(strings.Replace(valid, `"path":"data.sqlite3"`, `"path":"data.sqlite3","extra":true`, 1)), code: domain.RestoreValidationManifestKey},
		{name: "malformed JSON", body: []byte(`{"formatVersion":`), code: domain.RestoreValidationManifestJSON},
		{name: "unsupported format", body: restoreTestManifest(database, 2, 13), code: domain.RestoreValidationFormatVersion},
		{name: "unsupported schema", body: restoreTestManifest(database, 1, 12), code: domain.RestoreValidationSchemaVersion},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			archivePath := writeRestoreTestZIP(t, root, []restoreTestEntry{{name: "manifest.json", body: test.body}, {name: "data.sqlite3", body: database}})
			_, _, _, err := NewValidator().ValidateAndExtract(context.Background(), archivePath, root, 13)
			assertRestoreValidationCode(t, err, test.code)
			assertNoRestoreValidationDirectory(t, root)
		})
	}
}

func TestRestoreValidatorRejectsZIPEntryFailures(t *testing.T) {
	database := []byte("database")
	manifest := restoreTestManifest(database, 1, 13)
	tests := []struct {
		name    string
		entries []restoreTestEntry
	}{
		{name: "missing", entries: []restoreTestEntry{{name: "manifest.json", body: manifest}}},
		{name: "extra", entries: []restoreTestEntry{{name: "manifest.json", body: manifest}, {name: "data.sqlite3", body: database}, {name: "extra", body: nil}}},
		{name: "duplicate", entries: []restoreTestEntry{{name: "manifest.json", body: manifest}, {name: "data.sqlite3", body: database}, {name: "data.sqlite3", body: database}}},
		{name: "parent traversal", entries: []restoreTestEntry{{name: "manifest.json", body: manifest}, {name: "../data.sqlite3", body: database}}},
		{name: "absolute", entries: []restoreTestEntry{{name: "manifest.json", body: manifest}, {name: "C:\\data.sqlite3", body: database}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			archivePath := writeRestoreTestZIP(t, root, test.entries)
			_, _, _, err := NewValidator().ValidateAndExtract(context.Background(), archivePath, root, 13)
			assertRestoreValidationCode(t, err, domain.RestoreValidationZIPEntry)
		})
	}
}

func TestRestoreValidatorRejectsCorruptionSizeHashAndFreeSpace(t *testing.T) {
	database := []byte("unique-stored-database-payload-for-crc")
	tests := []struct {
		name      string
		manifest  []byte
		mutate    func(*testing.T, string)
		available *uint64
		code      domain.RestoreValidationCode
	}{
		{
			name:     "declared size",
			manifest: []byte(strings.Replace(string(restoreTestManifest(database, 1, 13)), fmt.Sprintf(`"sizeBytes":%d`, len(database)), fmt.Sprintf(`"sizeBytes":%d`, len(database)+1), 1)),
			code:     domain.RestoreValidationDeclaredSize,
		},
		{
			name:     "database SHA",
			manifest: []byte(strings.Replace(string(restoreTestManifest(database, 1, 13)), restoreTestHash(database), strings.Repeat("0", 64), 1)),
			code:     domain.RestoreValidationDatabaseSHA,
		},
		{
			name:     "CRC",
			manifest: restoreTestManifest(database, 1, 13),
			mutate: func(t *testing.T, path string) {
				contents, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				index := bytes.Index(contents, database)
				if index < 0 {
					t.Fatal("stored database payload was not found")
				}
				contents[index] ^= 0xFF
				if err := os.WriteFile(path, contents, 0o600); err != nil {
					t.Fatal(err)
				}
			},
			code: domain.RestoreValidationZIPCRC,
		},
		{
			name:      "free space",
			manifest:  restoreTestManifest(database, 1, 13),
			available: func() *uint64 { value := uint64(0); return &value }(),
			code:      domain.RestoreValidationFreeSpace,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			method := uint16(zip.Deflate)
			if test.name == "CRC" {
				method = zip.Store
			}
			archivePath := writeRestoreTestZIP(t, root, []restoreTestEntry{{name: "manifest.json", body: test.manifest}, {name: "data.sqlite3", body: database, method: method}})
			if test.mutate != nil {
				test.mutate(t, archivePath)
			}
			validator := NewValidator()
			if test.available != nil {
				validator.availableSpace = func(string) (uint64, error) { return *test.available, nil }
			}
			_, _, _, err := validator.ValidateAndExtract(context.Background(), archivePath, root, 13)
			assertRestoreValidationCode(t, err, test.code)
		})
	}
}

func TestRestoreValidatorRejectsTruncatedAndCancelledArchives(t *testing.T) {
	root := t.TempDir()
	database := bytes.Repeat([]byte("payload"), 64)
	archivePath := writeRestoreTestZIP(t, root, []restoreTestEntry{{name: "manifest.json", body: restoreTestManifest(database, 1, 13)}, {name: "data.sqlite3", body: database}})
	contents, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	truncatedPath := filepath.Join(root, "truncated.zip")
	if err := os.WriteFile(truncatedPath, contents[:len(contents)/2], 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, _, err = NewValidator().ValidateAndExtract(context.Background(), truncatedPath, root, 13)
	assertRestoreValidationCode(t, err, domain.RestoreValidationArchive)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, _, err = NewValidator().ValidateAndExtract(ctx, archivePath, root, 13)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled validation error = %v", err)
	}
	reader := &contextReader{ctx: ctx, reader: bytes.NewReader(database)}
	if _, err := io.ReadAll(reader); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled extraction reader error = %v", err)
	}
}

func writeRestoreTestZIP(t *testing.T, root string, entries []restoreTestEntry) string {
	t.Helper()
	path := filepath.Join(root, "restore-test.zip")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: entry.method}
		writer, err := archive.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func restoreTestManifest(database []byte, format int, schema int64) []byte {
	return []byte(fmt.Sprintf(`{"formatVersion":%d,"schemaVersion":%d,"appVersion":"test","createdAt":"2026-08-26T00:00:00Z","database":{"path":"data.sqlite3","sizeBytes":%d,"sha256":"%s"}}`, format, schema, len(database), restoreTestHash(database)))
}

func restoreTestHash(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}

func assertRestoreValidationCode(t *testing.T, err error, expected domain.RestoreValidationCode) {
	t.Helper()
	var validationErr *domain.RestoreValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("error = %v, want RestoreValidationError", err)
	}
	if validationErr.Code != expected {
		t.Fatalf("validation code = %q, want %q (error: %v)", validationErr.Code, expected, err)
	}
}

func assertNoRestoreValidationDirectory(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "restore-validated-") {
			t.Fatalf("failed validation left directory %q", entry.Name())
		}
	}
}
