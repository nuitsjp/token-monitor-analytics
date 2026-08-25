package sqlite

import (
	"context"
	"fmt"
	"path/filepath"

	modernsqlite "modernc.org/sqlite"
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
