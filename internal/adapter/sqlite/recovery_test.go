package sqlite

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRecoverPendingRestoreAllowsNoJournal(t *testing.T) {
	t.Parallel()
	if err := RecoverPendingRestore(t.TempDir()); err != nil {
		t.Fatalf("recover without journal: %v", err)
	}
}

func TestRecoverPendingRestoreStopsBeforeUnknownJournal(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, RestoreJournalName), []byte(`{"stage":"unknown"}`), 0o600); err != nil {
		t.Fatalf("write journal: %v", err)
	}
	if err := RecoverPendingRestore(directory); err == nil {
		t.Fatal("expected unknown journal to stop startup")
	}
}
