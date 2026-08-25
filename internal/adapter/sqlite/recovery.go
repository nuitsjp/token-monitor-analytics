package sqlite

import (
	"fmt"
	"os"
	"path/filepath"
)

const RestoreJournalName = "restore-journal.json"

// RecoverPendingRestore is deliberately conservative until T-044 implements
// the durable restore state machine. An unexpected journal prevents startup.
func RecoverPendingRestore(dataDirectory string) error {
	journalPath := filepath.Join(dataDirectory, RestoreJournalName)
	_, err := os.Stat(journalPath)
	if err == nil {
		return fmt.Errorf("pending restore journal requires recovery support: %s", RestoreJournalName)
	}
	if !os.IsNotExist(err) {
		return fmt.Errorf("inspect restore journal: %w", err)
	}
	return nil
}
