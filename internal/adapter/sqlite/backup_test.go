package sqlite

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOnlineBackupIncludesCommittedWALContent(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.sqlite3")
	backupPath := filepath.Join(directory, "backup.sqlite3")
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), sourcePath); err != nil {
		t.Fatalf("open source: %v", err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatalf("get source: %v", err)
	}
	if _, err := database.ExecContext(context.Background(), `UPDATE display_settings SET theme = 'dark' WHERE singleton = 1`); err != nil {
		t.Fatalf("write WAL content: %v", err)
	}
	if err := lifecycle.Backup(context.Background(), backupPath); err != nil {
		t.Fatalf("online backup: %v", err)
	}

	backup, err := sql.Open("sqlite", backupPath)
	if err != nil {
		t.Fatalf("open backup: %v", err)
	}
	var theme string
	if err := backup.QueryRowContext(context.Background(), `SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if theme != "dark" {
		t.Fatalf("backup theme = %q, want dark", theme)
	}
	if err := backup.Close(); err != nil {
		t.Fatalf("close backup: %v", err)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatalf("close source: %v", err)
	}

	replacementPath := filepath.Join(directory, "replacement.sqlite3")
	if err := os.Rename(backupPath, replacementPath); err != nil {
		t.Fatalf("rename closed backup on same volume: %v", err)
	}
}
