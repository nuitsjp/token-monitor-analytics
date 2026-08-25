package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

type applicationStorage struct {
	dataDirectory string
	lifecycle     *sqliteadapter.Lifecycle
	recovery      domain.RestoreRecoveryResult
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
	recovery, err := sqliteadapter.RecoverPendingRestore(dataDirectory)
	if err != nil {
		return nil, err
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)); err != nil {
		return nil, err
	}
	return &applicationStorage{dataDirectory: dataDirectory, lifecycle: lifecycle, recovery: recovery}, nil
}

func (s *applicationStorage) Close() error {
	return s.lifecycle.Close()
}
