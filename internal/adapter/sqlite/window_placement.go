package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

type WindowPlacement = domain.WindowPlacement

func (l *Lifecycle) GetWindowPlacement(ctx context.Context, kind string) (WindowPlacement, bool, error) {
	database, err := l.DB()
	if err != nil {
		return WindowPlacement{}, false, err
	}
	query, err := windowPlacementSelect(kind)
	if err != nil {
		return WindowPlacement{}, false, err
	}
	var x, y, width, height, dpi sql.NullInt64
	var monitor sql.NullString
	if err := database.QueryRowContext(ctx, query).Scan(&x, &y, &width, &height, &dpi, &monitor); err != nil {
		return WindowPlacement{}, false, fmt.Errorf("read %s window placement: %w", kind, err)
	}
	if !x.Valid || !y.Valid || !width.Valid || !height.Valid || !dpi.Valid || !monitor.Valid {
		return WindowPlacement{}, false, nil
	}
	placement := WindowPlacement{X: int(x.Int64), Y: int(y.Int64), Width: int(width.Int64), Height: int(height.Int64), DPI: int(dpi.Int64), Monitor: monitor.String}
	if placement.Width <= 0 || placement.Height <= 0 || placement.DPI <= 0 || placement.Monitor == "" {
		return WindowPlacement{}, false, nil
	}
	return placement, true, nil
}

func (l *Lifecycle) SaveWindowPlacement(ctx context.Context, kind string, placement WindowPlacement) error {
	if placement.Width <= 0 || placement.Height <= 0 || placement.DPI <= 0 || placement.Monitor == "" {
		return errors.New("window placement is invalid")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	query, err := windowPlacementUpdate(kind)
	if err != nil {
		return err
	}
	if _, err := database.ExecContext(ctx, query, placement.X, placement.Y, placement.Width, placement.Height, placement.DPI, placement.Monitor); err != nil {
		return fmt.Errorf("save %s window placement: %w", kind, err)
	}
	return nil
}

func windowPlacementSelect(kind string) (string, error) {
	switch kind {
	case "compact":
		return `SELECT compact_window_x, compact_window_y, compact_window_width, compact_window_height, compact_window_dpi, compact_window_monitor FROM display_settings WHERE singleton = 1`, nil
	case "main":
		return `SELECT main_window_x, main_window_y, main_window_width, main_window_height, main_window_dpi, main_window_monitor FROM display_settings WHERE singleton = 1`, nil
	default:
		return "", errors.New("window kind is invalid")
	}
}

func windowPlacementUpdate(kind string) (string, error) {
	switch kind {
	case "compact":
		return `UPDATE display_settings SET compact_window_x = ?, compact_window_y = ?, compact_window_width = ?, compact_window_height = ?, compact_window_dpi = ?, compact_window_monitor = ? WHERE singleton = 1`, nil
	case "main":
		return `UPDATE display_settings SET main_window_x = ?, main_window_y = ?, main_window_width = ?, main_window_height = ?, main_window_dpi = ?, main_window_monitor = ? WHERE singleton = 1`, nil
	default:
		return "", errors.New("window kind is invalid")
	}
}
