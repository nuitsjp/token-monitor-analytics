package sqlite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRestoreJournalRejectsNoncanonicalJSON(t *testing.T) {
	valid := `{"journalVersion":1,"stage":"prepared","operationID":"operation-one","artifactSha256":"` + repeatHex("a") + `","backupFormatVersion":1,"schemaVersion":13,"restoredAt":"2026-08-26T00:00:00Z","auditID":"audit-one","originalWal":false,"originalShm":false}`
	tests := map[string]string{
		"bom":       "\ufeff" + valid,
		"duplicate": `{"journalVersion":1,"journalVersion":1,"stage":"prepared","operationID":"operation-one","artifactSha256":"` + repeatHex("a") + `","backupFormatVersion":1,"schemaVersion":13,"restoredAt":"2026-08-26T00:00:00Z","auditID":"audit-one","originalWal":false,"originalShm":false}`,
		"unknown":   valid[:len(valid)-1] + `,"path":"C:\\secret"}`,
		"missing":   strings.Replace(valid, `,"originalShm":false`, "", 1),
		"trailing":  valid + `{}`,
	}
	for name, contents := range tests {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), RestoreJournalName)
			if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readRestoreJournal(path); err == nil {
				t.Fatal("noncanonical restore journal was accepted")
			}
		})
	}
}

func TestRestoreJournalRoundTripUsesOnlyFixedMetadata(t *testing.T) {
	paths, err := newRestorePaths(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	want := restoreJournal{
		JournalVersion: restoreJournalVersion, Stage: restoreStageReplacementMoved,
		OperationID: "operation-one", ArtifactSHA256: repeatHex("e"),
		BackupFormatVersion: 1, SchemaVersion: CurrentSchemaVersion,
		RestoredAt: time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano), AuditID: "audit-one",
		OriginalWAL: true, OriginalSHM: true,
	}
	if err := writeRestoreJournal(paths, want); err != nil {
		t.Fatal(err)
	}
	got, err := readRestoreJournal(paths.journal)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("journal = %+v, want %+v", got, want)
	}
	if _, err := os.Lstat(paths.journalTemporary); !os.IsNotExist(err) {
		t.Fatal("temporary journal remains after atomic replace")
	}
}
