package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

func (l *Lifecycle) GetDisplaySettings(ctx context.Context) (domain.DisplaySettings, error) {
	database, err := l.DB()
	if err != nil {
		return domain.DisplaySettings{}, err
	}
	var theme string
	var displayTimezone sql.NullString
	var timezoneConfirmed int64
	err = database.QueryRowContext(ctx, `SELECT theme, display_timezone, timezone_confirmed FROM display_settings WHERE singleton = 1`).Scan(&theme, &displayTimezone, &timezoneConfirmed)
	if err != nil {
		return domain.DisplaySettings{}, fmt.Errorf("read display settings: %w", err)
	}
	return domain.DisplaySettings{
		Theme:             theme,
		DisplayTimezone:   displayTimezone.String,
		TimezoneConfirmed: timezoneConfirmed == 1,
	}, nil
}

func (l *Lifecycle) UpdateDisplaySettings(ctx context.Context, theme, displayTimezone string) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin display settings update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE display_settings SET theme = ? WHERE singleton = 1`, theme); err != nil {
		return fmt.Errorf("update display theme: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE display_settings SET display_timezone = ?, timezone_confirmed = ? WHERE singleton = 1`, sql.NullString{String: displayTimezone, Valid: displayTimezone != ""}, 1); err != nil {
		return fmt.Errorf("update display timezone: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit display settings update: %w", err)
	}
	return nil
}
