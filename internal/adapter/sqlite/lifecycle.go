package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

type Lifecycle struct {
	mu           sync.Mutex
	database     *sql.DB
	databasePath string
}

func (l *Lifecycle) Open(ctx context.Context, path string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.database != nil {
		return fmt.Errorf("database is already open")
	}
	absolutePath, database, err := openLifecycleDatabase(ctx, path)
	if err != nil {
		return err
	}
	l.database = database
	l.databasePath = absolutePath
	return nil
}

func openLifecycleDatabase(ctx context.Context, path string) (string, *sql.DB, error) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return "", nil, fmt.Errorf("resolve database path: %w", err)
	}
	urlPath := filepath.ToSlash(absolutePath)
	if filepath.VolumeName(absolutePath) != "" {
		urlPath = "/" + urlPath
	}
	dsn := (&url.URL{Scheme: "file", Path: urlPath, RawQuery: "mode=rwc&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"}).String()
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return "", nil, fmt.Errorf("open database: %w", err)
	}
	database.SetMaxOpenConns(1)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return "", nil, fmt.Errorf("ping database: %w", err)
	}
	if err := backupBeforeMigration(ctx, database, absolutePath); err != nil {
		_ = database.Close()
		return "", nil, err
	}
	if err := migrate(ctx, database); err != nil {
		_ = database.Close()
		return "", nil, err
	}
	return absolutePath, database, nil
}

func backupBeforeMigration(ctx context.Context, database *sql.DB, databasePath string) error {
	var tableName string
	err := database.QueryRowContext(ctx, `
		SELECT name
		FROM sqlite_master
		WHERE type = 'table' AND name = 'schema_metadata'
	`).Scan(&tableName)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect schema before migration: %w", err)
	}
	var schemaVersion int64
	if err := database.QueryRowContext(ctx, `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read schema before migration: %w", err)
	}
	if schemaVersion >= CurrentSchemaVersion {
		return nil
	}
	backupPath := preMigrationBackupPath(databasePath, schemaVersion)
	if _, err := os.Lstat(backupPath); err == nil {
		if err := validatePreMigrationBackup(ctx, backupPath, schemaVersion); err != nil {
			return fmt.Errorf("existing pre-migration backup is invalid: %w", err)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect pre-migration backup: %w", err)
	}
	if err := createOnlineBackup(ctx, database, backupPath); err != nil {
		_ = os.Remove(backupPath)
		return fmt.Errorf("create pre-migration backup: %w", err)
	}
	if err := validatePreMigrationBackup(ctx, backupPath, schemaVersion); err != nil {
		_ = os.Remove(backupPath)
		return fmt.Errorf("validate pre-migration backup: %w", err)
	}
	return nil
}

func preMigrationBackupPath(databasePath string, schemaVersion int64) string {
	extension := filepath.Ext(databasePath)
	base := strings.TrimSuffix(filepath.Base(databasePath), extension)
	return filepath.Join(filepath.Dir(databasePath), fmt.Sprintf("%s.pre-migration-v%d%s", base, schemaVersion, extension))
}

func validatePreMigrationBackup(ctx context.Context, backupPath string, expectedVersion int64) error {
	database, err := sql.Open("sqlite", backupPath)
	if err != nil {
		return fmt.Errorf("open backup: %w", err)
	}
	defer func() { _ = database.Close() }()
	var integrity string
	if err := database.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return fmt.Errorf("check backup integrity: %w", err)
	}
	if integrity != "ok" {
		return fmt.Errorf("backup integrity check returned %q", integrity)
	}
	var schemaVersion int64
	if err := database.QueryRowContext(ctx, `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read backup schema: %w", err)
	}
	if schemaVersion != expectedVersion {
		return fmt.Errorf("backup schema version %d does not match source version %d", schemaVersion, expectedVersion)
	}
	return nil
}

func (l *Lifecycle) DB() (*sql.DB, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.database == nil {
		return nil, fmt.Errorf("database is not open")
	}
	return l.database, nil
}

func (l *Lifecycle) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.database == nil {
		return nil
	}
	err := l.database.Close()
	l.database = nil
	l.databasePath = ""
	if err != nil {
		return fmt.Errorf("close database: %w", err)
	}
	return nil
}
