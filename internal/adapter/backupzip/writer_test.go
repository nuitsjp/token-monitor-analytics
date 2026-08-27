package backupzip

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"token-monitor-analytics/internal/domain"
)

type renameReplacer struct {
	err   error
	calls int
}

func (r *renameReplacer) Replace(sourcePath, destinationPath string) error {
	r.calls++
	if r.err != nil {
		return r.err
	}
	return os.Rename(sourcePath, destinationPath)
}

type failureAt struct {
	point string
}

func (f failureAt) Check(point string) error {
	if point == f.point {
		return errors.New("injected")
	}
	return nil
}

type commitIdentityInjector struct {
	destination string
	protected   string
}

func (i commitIdentityInjector) Check(point string) error {
	if point == "before-commit" {
		return os.Link(i.protected, i.destination)
	}
	return nil
}

func TestWriterCreatesExactlyTwoEntriesAndReturnsArtifactHash(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	destinationDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(destinationDir, 0o700); err != nil {
		t.Fatalf("create destination directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "backup-temp.sqlite3")
	if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
		t.Fatalf("write database fixture: %v", err)
	}
	destination := filepath.Join(destinationDir, "analytics-backup.zip")
	replacer := &renameReplacer{}
	writer, err := NewWriterWithAtomicReplacer(replacer)
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	artifact, err := writer.Write(context.Background(), destination, dataDir, databasePath, []string{databasePath, databasePath + "-wal", databasePath + "-shm"}, testManifest(), nil)
	if err != nil {
		t.Fatalf("write backup: %v", err)
	}
	if replacer.calls != 1 {
		t.Fatalf("atomic replace calls = %d, want 1", replacer.calls)
	}
	if artifact.Path != destination || artifact.SizeBytes <= 0 || artifact.ArtifactSHA256 == "" || artifact.Warning != "" {
		t.Fatalf("artifact = %#v", artifact)
	}
	archive, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatalf("open artifact: %v", err)
	}
	t.Cleanup(func() {
		if err := archive.Close(); err != nil {
			t.Errorf("close archive: %v", err)
		}
	})
	t.Run("P1-BACKUP-02 strict two-entry ZIP and manifest", func(t *testing.T) {
		if len(archive.File) != 2 || archive.File[0].Name != "manifest.json" || archive.File[1].Name != "data.sqlite3" {
			t.Fatalf("archive entries = %#v", archive.File)
		}
		manifestReader, err := archive.File[0].Open()
		if err != nil {
			t.Fatal(err)
		}
		manifestBytes, err := io.ReadAll(manifestReader)
		_ = manifestReader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if len(manifestBytes) >= 3 && string(manifestBytes[:3]) == "\xEF\xBB\xBF" {
			t.Fatal("manifest unexpectedly has a BOM")
		}
		manifest, err := parseManifest(manifestBytes)
		if err != nil {
			t.Fatalf("parse written manifest: %v", err)
		}
		if !sameManifest(manifest, testManifest()) || manifest.Database.Path != "data.sqlite3" || manifest.FormatVersion != domain.BackupFormatVersion {
			t.Fatalf("written manifest = %#v", manifest)
		}
		if matches, err := filepath.Glob(filepath.Join(destinationDir, ".backup-*.part")); err != nil {
			t.Fatalf("inspect temporary archives: %v", err)
		} else if len(matches) != 0 {
			t.Fatalf("temporary archives unexpectedly remain: %#v", matches)
		}
	})
}

func TestWriterReportsValidationAfterClosingArchiveAndValidationFailureKeepsExistingArtifact(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	destinationDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(destinationDir, 0o700); err != nil {
		t.Fatalf("create destination directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "backup-temp.sqlite3")
	if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
		t.Fatalf("write database fixture: %v", err)
	}
	destination := filepath.Join(destinationDir, "analytics-backup.zip")
	before := []byte("existing artifact")
	if err := os.WriteFile(destination, before, 0o600); err != nil {
		t.Fatalf("write existing artifact: %v", err)
	}
	replacer := &renameReplacer{}
	writer, err := NewWriterWithAtomicReplacer(replacer)
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	reports := 0
	reportValidating := func(progress BackupArchiveProgress) {
		if progress != BackupArchiveProgressValidating {
			t.Fatalf("writer progress = %q", progress)
		}
		reports++
		matches, globErr := filepath.Glob(filepath.Join(destinationDir, ".backup-*.part"))
		if globErr != nil || len(matches) != 1 {
			t.Fatalf("temporary archive at validation boundary = %#v, %v", matches, globErr)
		}
		if writeErr := os.WriteFile(matches[0], []byte("invalid ZIP"), 0o600); writeErr != nil {
			t.Fatalf("temporary archive was not closed before validation report: %v", writeErr)
		}
	}
	if _, err := writer.Write(context.Background(), destination, dataDir, databasePath, []string{databasePath}, testManifest(), reportValidating); err == nil {
		t.Fatal("corrupted readback unexpectedly succeeded")
	}
	t.Run("P1-BACKUP-06 readback validation and atomic replacement", func(t *testing.T) {
		if reports != 1 {
			t.Fatalf("validation reports = %d, want 1", reports)
		}
		after, err := os.ReadFile(destination)
		if err != nil {
			t.Fatalf("read existing artifact: %v", err)
		}
		if string(after) != string(before) {
			t.Fatalf("existing artifact changed from %q to %q", before, after)
		}
		if replacer.calls != 0 {
			t.Fatalf("atomic replacement called %d times", replacer.calls)
		}
		if matches, err := filepath.Glob(filepath.Join(destinationDir, ".backup-*.part")); err != nil {
			t.Fatalf("inspect temporary archives after failed validation: %v", err)
		} else if len(matches) != 0 {
			t.Fatalf("temporary archives remain after failed validation: %#v", matches)
		}
	})
}

func TestWriterRejectsApplicationDataDestinationAndHardlinkAlias(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	exportDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(exportDir, 0o700); err != nil {
		t.Fatalf("create export directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "analytics.sqlite3")
	if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
		t.Fatalf("write database fixture: %v", err)
	}
	writer, err := NewWriterWithAtomicReplacer(&renameReplacer{})
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	inside := filepath.Join(dataDir, "backup.zip")
	if _, err := writer.Write(context.Background(), inside, dataDir, databasePath, []string{databasePath}, testManifest(), nil); err == nil {
		t.Fatal("application data destination unexpectedly accepted")
	}
	alias := filepath.Join(exportDir, "alias.zip")
	if err := os.Link(databasePath, alias); err != nil {
		t.Skipf("hardlink fixture unavailable: %v", err)
	}
	if _, err := writer.Write(context.Background(), alias, dataDir, databasePath, []string{databasePath}, testManifest(), nil); err == nil {
		t.Fatal("hardlink alias unexpectedly accepted")
	}
}

func TestWriterPrecommitFailuresKeepExistingArtifactUnchanged(t *testing.T) {
	points := []string{"after-destination-check", "after-database-check", "after-archive-readback", "before-commit"}
	for _, point := range points {
		t.Run(point, func(t *testing.T) {
			root := t.TempDir()
			dataDir := filepath.Join(root, "app-data")
			destinationDir := filepath.Join(root, "exports")
			if err := os.MkdirAll(dataDir, 0o700); err != nil {
				t.Fatalf("create data directory: %v", err)
			}
			if err := os.MkdirAll(destinationDir, 0o700); err != nil {
				t.Fatalf("create destination directory: %v", err)
			}
			databasePath := filepath.Join(dataDir, "backup-temp.sqlite3")
			if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
				t.Fatalf("write database fixture: %v", err)
			}
			destination := filepath.Join(destinationDir, "analytics-backup.zip")
			before := []byte("existing artifact")
			if err := os.WriteFile(destination, before, 0o600); err != nil {
				t.Fatalf("write existing artifact: %v", err)
			}
			replacer := &renameReplacer{}
			writer, err := NewWriterWithAtomicReplacerAndFailureInjector(replacer, failureAt{point: point})
			if err != nil {
				t.Fatalf("create writer: %v", err)
			}
			if _, err := writer.Write(context.Background(), destination, dataDir, databasePath, []string{databasePath}, testManifest(), nil); err == nil {
				t.Fatal("injected failure unexpectedly succeeded")
			}
			after, err := os.ReadFile(destination)
			if err != nil {
				t.Fatalf("read existing artifact: %v", err)
			}
			if string(after) != string(before) {
				t.Fatalf("existing artifact changed from %q to %q", before, after)
			}
			if replacer.calls != 0 {
				t.Fatalf("atomic replacement called %d times", replacer.calls)
			}
		})
	}
}

func TestWriterRechecksDestinationIdentityAtCommit(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	destinationDir := filepath.Join(root, "exports")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	if err := os.MkdirAll(destinationDir, 0o700); err != nil {
		t.Fatalf("create destination directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "analytics.sqlite3")
	if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
		t.Fatalf("write database fixture: %v", err)
	}
	destination := filepath.Join(destinationDir, "analytics-backup.zip")
	replacer := &renameReplacer{}
	writer, err := NewWriterWithAtomicReplacerAndFailureInjector(replacer, commitIdentityInjector{destination: destination, protected: databasePath})
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	if _, err := writer.Write(context.Background(), destination, dataDir, databasePath, []string{databasePath}, testManifest(), nil); err == nil {
		t.Fatal("destination identity race unexpectedly committed")
	}
	if replacer.calls != 0 {
		t.Fatalf("atomic replacement called %d times", replacer.calls)
	}
}

func TestWriterRejectsReparseDestinationParent(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "app-data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatalf("create data directory: %v", err)
	}
	databasePath := filepath.Join(dataDir, "analytics.sqlite3")
	if err := os.WriteFile(databasePath, []byte("test"), 0o600); err != nil {
		t.Fatalf("write database fixture: %v", err)
	}
	link := filepath.Join(root, "linked-exports")
	if err := os.Symlink(dataDir, link); err != nil {
		t.Skipf("reparse fixture unavailable: %v", err)
	}
	writer, err := NewWriterWithAtomicReplacer(&renameReplacer{})
	if err != nil {
		t.Fatalf("create writer: %v", err)
	}
	if _, err := writer.Write(context.Background(), filepath.Join(link, "backup.zip"), dataDir, databasePath, []string{databasePath}, testManifest(), nil); err == nil {
		t.Fatal("reparse destination unexpectedly accepted")
	}
}
