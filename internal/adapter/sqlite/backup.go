package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	modernsqlite "modernc.org/sqlite"
	"token-monitor-analytics/internal/domain"
)

type onlineBackuper interface {
	NewBackup(destinationURI string) (*modernsqlite.Backup, error)
}

func (l *Lifecycle) Backup(ctx context.Context, destinationPath string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.database == nil {
		return fmt.Errorf("database is not open")
	}
	absolutePath, err := filepath.Abs(destinationPath)
	if err != nil {
		return fmt.Errorf("resolve backup path: %w", err)
	}
	if _, err := os.Lstat(absolutePath); err == nil {
		return fmt.Errorf("backup destination already exists")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect backup destination: %w", err)
	}
	connection, err := l.database.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire backup connection: %w", err)
	}
	defer connection.Close()
	if err := connection.Raw(func(raw any) error {
		backuper, ok := raw.(onlineBackuper)
		if !ok {
			return fmt.Errorf("SQLite driver does not support online backup")
		}
		backup, err := backuper.NewBackup(absolutePath)
		if err != nil {
			return fmt.Errorf("start online backup: %w", err)
		}
		more, err := backup.Step(-1)
		if err != nil {
			_ = backup.Finish()
			return fmt.Errorf("copy online backup: %w", err)
		}
		if more {
			_ = backup.Finish()
			return fmt.Errorf("online backup did not finish")
		}
		destinationConnection, err := backup.Commit()
		if err != nil {
			return fmt.Errorf("commit online backup: %w", err)
		}
		if err := destinationConnection.Close(); err != nil {
			return fmt.Errorf("close online backup: %w", err)
		}
		return nil
	}); err != nil {
		return err
	}
	return nil
}

func (l *Lifecycle) DatabasePath() (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.database == nil || l.databasePath == "" {
		return "", fmt.Errorf("database is not open")
	}
	return l.databasePath, nil
}

func (l *Lifecycle) ApplicationDataDirectory() (string, error) {
	path, err := l.DatabasePath()
	if err != nil {
		return "", err
	}
	return filepath.Dir(path), nil
}

func (l *Lifecycle) SchemaVersion() int64 { return CurrentSchemaVersion }

func (l *Lifecycle) ProtectedBackupPaths() ([]string, error) {
	databasePath, err := l.DatabasePath()
	if err != nil {
		return nil, err
	}
	dataDirectory := filepath.Dir(databasePath)
	paths := []string{
		databasePath,
		databasePath + "-wal",
		databasePath + "-shm",
		filepath.Join(dataDirectory, RestoreJournalName),
	}
	entries, err := os.ReadDir(dataDirectory)
	if err != nil {
		return nil, fmt.Errorf("list protected backup files: %w", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, "backup-temp-") || strings.HasPrefix(name, "restore-") || strings.HasPrefix(name, ".backup-") {
			paths = append(paths, filepath.Join(dataDirectory, name))
		}
	}
	return paths, nil
}

func (l *Lifecycle) ValidateBackupDatabase(ctx context.Context, path string) error {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve temporary backup database: %w", err)
	}
	database, err := sql.Open("sqlite", sqliteReadWriteDSN(absolutePath))
	if err != nil {
		return fmt.Errorf("open temporary backup database: %w", err)
	}
	var validationErr error
	if err := database.PingContext(ctx); err != nil {
		validationErr = fmt.Errorf("ping temporary backup database: %w", err)
	} else {
		if err := validateBackupSchema(ctx, database); err != nil {
			validationErr = err
		}
	}
	if validationErr == nil {
		var integrity string
		if err := database.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
			validationErr = fmt.Errorf("run integrity_check: %w", err)
		} else if integrity != "ok" {
			validationErr = fmt.Errorf("integrity_check returned %q", integrity)
		}
	}
	if validationErr == nil {
		if err := validateRawSnapshots(ctx, database); err != nil {
			validationErr = err
		}
	}
	if validationErr == nil {
		rows, err := database.QueryContext(ctx, `PRAGMA foreign_key_check`)
		if err != nil {
			validationErr = fmt.Errorf("run foreign_key_check: %w", err)
		} else {
			if rows.Next() {
				validationErr = fmt.Errorf("foreign_key_check found a violation")
			}
			if closeErr := rows.Close(); validationErr == nil && closeErr != nil {
				validationErr = fmt.Errorf("close foreign_key_check: %w", closeErr)
			}
			if validationErr == nil {
				if err := rows.Err(); err != nil {
					validationErr = fmt.Errorf("read foreign_key_check: %w", err)
				}
			}
		}
	}
	if validationErr == nil {
		if _, err := database.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
			validationErr = fmt.Errorf("checkpoint temporary backup database: %w", err)
		}
	}
	closeErr := database.Close()
	if validationErr != nil {
		return validationErr
	}
	if closeErr != nil {
		return fmt.Errorf("close temporary backup database: %w", closeErr)
	}
	file, err := os.OpenFile(absolutePath, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open temporary backup database for flush: %w", err)
	}
	syncErr := file.Sync()
	fileCloseErr := file.Close()
	if syncErr != nil {
		return fmt.Errorf("flush temporary backup database: %w", syncErr)
	}
	if fileCloseErr != nil {
		return fmt.Errorf("close flushed temporary backup database: %w", fileCloseErr)
	}
	for _, sidecar := range []string{absolutePath + "-wal", absolutePath + "-shm"} {
		if _, err := os.Stat(sidecar); err == nil {
			return fmt.Errorf("temporary backup database sidecar exists")
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("inspect temporary backup database sidecar: %w", err)
		}
	}
	return nil
}

func validateBackupSchema(ctx context.Context, database *sql.DB) error {
	var schemaVersion int64
	if err := database.QueryRowContext(ctx, `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read backup schema version: %w", err)
	}
	if schemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("backup schema version %d does not match current schema version %d", schemaVersion, CurrentSchemaVersion)
	}
	rows, err := database.QueryContext(ctx, `SELECT type, name, COALESCE(sql, '') FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')`)
	if err != nil {
		return fmt.Errorf("inspect backup schema: %w", err)
	}
	for rows.Next() {
		var objectType, name, definition string
		if err := rows.Scan(&objectType, &name, &definition); err != nil {
			return fmt.Errorf("read backup schema object: %w", err)
		}
		if domain.IsRawSecretField(name) || containsForbiddenIdentifier(definition) {
			return fmt.Errorf("backup schema contains a prohibited secret field")
		}
		_ = objectType
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read backup schema objects: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close backup schema objects: %w", err)
	}
	var theme string
	var displayTimezone sql.NullString
	if err := database.QueryRowContext(ctx, `SELECT theme, display_timezone FROM display_settings WHERE singleton = 1`).Scan(&theme, &displayTimezone); err != nil {
		return fmt.Errorf("read backup display settings: %w", err)
	}
	if theme != "light" && theme != "dark" && theme != "system" {
		return fmt.Errorf("backup display settings contain a prohibited value")
	}
	if displayTimezone.Valid && strings.TrimSpace(displayTimezone.String) == "" {
		return fmt.Errorf("backup display settings contain an invalid timezone")
	}
	return nil
}

func containsForbiddenIdentifier(value string) bool {
	for _, field := range strings.FieldsFunc(value, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') && !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '_'
	}) {
		if domain.IsRawSecretField(field) {
			return true
		}
	}
	return false
}

func validateRawSnapshots(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `SELECT response_kind, body FROM raw_snapshots`)
	if err != nil {
		return fmt.Errorf("read raw snapshots for backup: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind string
		var body []byte
		if err := rows.Scan(&kind, &body); err != nil {
			return fmt.Errorf("read raw snapshot for backup: %w", err)
		}
		if err := validateRawSnapshotBody(body, kind); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read raw snapshots for backup: %w", err)
	}
	return nil
}

func validateRawSnapshotBody(body []byte, kind string) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return fmt.Errorf("backup raw snapshot JSON is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("backup raw snapshot JSON has trailing data")
	}
	if _, ok := value.(map[string]any); !ok {
		return fmt.Errorf("backup raw snapshot root is not an object")
	}
	if err := walkRawSnapshotValue(value, kind, nil); err != nil {
		return err
	}
	return nil
}

func walkRawSnapshotValue(value any, kind string, parts []string) error {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			childParts := append(append([]string(nil), parts...), key)
			if domain.IsRawSecretField(key) || !domain.IsKnownRawField(kind, childParts) {
				return fmt.Errorf("backup raw snapshot contains an unclassified field")
			}
			if err := walkRawSnapshotValue(child, kind, childParts); err != nil {
				return err
			}
		}
	case []any:
		for index, child := range typed {
			if err := walkRawSnapshotValue(child, kind, append(parts, fmt.Sprintf("[%d]", index))); err != nil {
				return err
			}
		}
	}
	return nil
}

func sqliteReadWriteDSN(path string) string {
	urlPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" {
		urlPath = "/" + urlPath
	}
	return (&url.URL{Scheme: "file", Path: urlPath, RawQuery: "mode=rw&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"}).String()
}
