package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
)

type applicationStorage struct {
	dataDirectory string
	lifecycle     *sqliteadapter.Lifecycle
}

func openApplicationStorage(ctx context.Context) (*applicationStorage, error) {
	configDirectory, err := os.UserConfigDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user configuration directory: %w", err)
	}
	dataDirectory := filepath.Join(configDirectory, "TokenMonitorAnalytics")
	if err := os.MkdirAll(dataDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create application data directory: %w", err)
	}
	if err := sqliteadapter.RecoverPendingRestore(dataDirectory); err != nil {
		return nil, err
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(dataDirectory, "analytics.sqlite3")); err != nil {
		return nil, err
	}
	return &applicationStorage{dataDirectory: dataDirectory, lifecycle: lifecycle}, nil
}

func (s *applicationStorage) Close() error {
	return s.lifecycle.Close()
}
