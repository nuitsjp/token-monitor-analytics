package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
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
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve database path: %w", err)
	}
	urlPath := filepath.ToSlash(absolutePath)
	if filepath.VolumeName(absolutePath) != "" {
		urlPath = "/" + urlPath
	}
	dsn := (&url.URL{Scheme: "file", Path: urlPath, RawQuery: "mode=rwc&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)"}).String()
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	database.SetMaxOpenConns(1)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return fmt.Errorf("ping database: %w", err)
	}
	if err := migrate(database); err != nil {
		_ = database.Close()
		return err
	}
	l.database = database
	l.databasePath = absolutePath
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
