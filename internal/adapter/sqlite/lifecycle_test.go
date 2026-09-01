package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/pressly/goose/v3"
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

	if _, err := database.ExecContext(context.Background(), `UPDATE display_settings SET theme = 'dark' WHERE singleton = 1`); err != nil {
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
	if err := database.QueryRowContext(t.Context(), `SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&theme); err != nil {
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
	if err := database.QueryRowContext(t.Context(), `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if schemaVersion != CurrentSchemaVersion {
		t.Fatalf("schema version = %d, want %d", schemaVersion, CurrentSchemaVersion)
	}
}

func TestLifecycleBacksUpExistingDatabaseBeforeMigration(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "analytics.sqlite3")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open version 14 database: %v", err)
	}
	migrationMu.Lock()
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("sqlite3"); err != nil {
		migrationMu.Unlock()
		_ = database.Close()
		t.Fatalf("set migration dialect: %v", err)
	}
	err = goose.UpToContext(t.Context(), database, "migrations", 14)
	migrationMu.Unlock()
	if err != nil {
		_ = database.Close()
		t.Fatalf("migrate fixture to version 14: %v", err)
	}
	if _, err := database.ExecContext(t.Context(), `UPDATE display_settings SET theme = 'dark' WHERE singleton = 1`); err != nil {
		_ = database.Close()
		t.Fatalf("update version 14 fixture: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatalf("close version 14 database: %v", err)
	}

	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(t.Context(), path); err != nil {
		t.Fatalf("open and migrate database: %v", err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })

	backupPath := filepath.Join(directory, "analytics.pre-migration-v14.sqlite3")
	backup, err := sql.Open("sqlite", backupPath)
	if err != nil {
		t.Fatalf("open pre-migration backup: %v", err)
	}
	defer func() { _ = backup.Close() }()
	var backupVersion int64
	var backupTheme string
	if err := backup.QueryRowContext(t.Context(), `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&backupVersion); err != nil {
		t.Fatalf("read backup schema version: %v", err)
	}
	if err := backup.QueryRowContext(t.Context(), `SELECT theme FROM display_settings WHERE singleton = 1`).Scan(&backupTheme); err != nil {
		t.Fatalf("read backup data: %v", err)
	}
	if backupVersion != 14 || backupTheme != "dark" {
		t.Fatalf("backup version/theme = %d/%q, want 14/dark", backupVersion, backupTheme)
	}

	active, err := lifecycle.DB()
	if err != nil {
		t.Fatalf("get migrated database: %v", err)
	}
	var activeVersion int64
	if err := active.QueryRowContext(t.Context(), `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&activeVersion); err != nil {
		t.Fatalf("read active schema version: %v", err)
	}
	if activeVersion != CurrentSchemaVersion {
		t.Fatalf("active schema version = %d, want %d", activeVersion, CurrentSchemaVersion)
	}
}

func assertPragma(t *testing.T, database *sql.DB, name, want string) {
	t.Helper()
	var got string
	if err := database.QueryRowContext(t.Context(), "PRAGMA "+name).Scan(&got); err != nil {
		t.Fatalf("read PRAGMA %s: %v", name, err)
	}
	if got != want {
		t.Fatalf("PRAGMA %s = %q, want %q", name, got, want)
	}
}
