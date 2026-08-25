package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLifecycleMigratesAndReopensFileDatabase(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "analytics.sqlite3")
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), path); err != nil {
		t.Fatalf("open database: %v", err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatalf("get database: %v", err)
	}

	assertPragma(t, database, "journal_mode", "wal")
	assertPragma(t, database, "synchronous", "2")
	assertPragma(t, database, "foreign_keys", "1")
	assertPragma(t, database, "busy_timeout", "5000")

	if _, err := database.Exec(`UPDATE display_settings SET theme = 'dark' WHERE singleton = 1`); err != nil {
		t.Fatalf("update settings: %v", err)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatalf("close database: %v", err)
	}
	if err := lifecycle.Open(context.Background(), path); err != nil {
		t.Fatalf("reopen database: %v", err)
	}
	database, err = lifecycle.DB()
	if err != nil {
		t.Fatalf("get reopened database: %v", err)
	}
	var theme string
	if err := database.QueryRow(`SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
		t.Fatalf("read persisted setting: %v", err)
	}
	if theme != "dark" {
		t.Fatalf("theme = %q, want dark", theme)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatalf("close reopened database: %v", err)
	}
}

func TestMigrationVersionMatchesSchemaVersion(t *testing.T) {
	t.Parallel()
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "schema.sqlite3")); err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatalf("get database: %v", err)
	}
	var schemaVersion int64
	if err := database.QueryRow(`SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if schemaVersion != CurrentSchemaVersion {
		t.Fatalf("schema version = %d, want %d", schemaVersion, CurrentSchemaVersion)
	}
}

func assertPragma(t *testing.T, database *sql.DB, name, want string) {
	t.Helper()
	var got string
	if err := database.QueryRow("PRAGMA " + name).Scan(&got); err != nil {
		t.Fatalf("read PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %q, want %q", name, got, want)
	}
}
