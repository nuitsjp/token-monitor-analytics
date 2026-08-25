package desktop

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	timezoneadapter "token-monitor-analytics/internal/adapter/timezone"
	"token-monitor-analytics/internal/usecase"
)

type SettingsSnapshot struct {
	Theme           string   `json:"theme"`
	DisplayTimeZone string   `json:"displayTimeZone"`
	IANATimeZones   []string `json:"ianaTimeZones"`
	SystemDark      bool     `json:"systemDark"`
}

type SaveSettingsInput struct {
	Theme           string `json:"theme"`
	DisplayTimeZone string `json:"displayTimeZone"`
}

type SettingsService struct {
	lifecycle *sqliteadapter.Lifecycle
	gate      *usecase.MaintenanceGate
}

func NewSettingsService(lifecycle *sqliteadapter.Lifecycle, gate *usecase.MaintenanceGate) *SettingsService {
	return &SettingsService{lifecycle: lifecycle, gate: gate}
}

func RegisterThemeSync(app *application.App, service *SettingsService) {
	app.Event.OnApplicationEvent(events.Common.ThemeChanged, func(event *application.ApplicationEvent) {
		snapshot, err := service.GetSettings(context.Background())
		if err != nil {
			return
		}
		snapshot.SystemDark = event.Context().IsDarkMode()
		app.Event.Emit("settings:theme-changed", snapshot)
	})
}

func (s *SettingsService) GetSettings(ctx context.Context) (SettingsSnapshot, error) {
	database, err := s.lifecycle.DB()
	if err != nil {
		return SettingsSnapshot{}, err
	}
	var theme string
	var displayTimeZone sql.NullString
	var confirmed int
	if err := database.QueryRowContext(ctx, `
		SELECT theme, display_timezone, timezone_confirmed
		FROM display_settings WHERE singleton = 1`,
	).Scan(&theme, &displayTimeZone, &confirmed); err != nil {
		return SettingsSnapshot{}, fmt.Errorf("read display settings: %w", err)
	}
	zone := ""
	if confirmed == 1 && displayTimeZone.Valid {
		zone = displayTimeZone.String
	} else if windowsID, err := timezoneadapter.CurrentWindowsID(); err == nil {
		zone, _ = timezoneadapter.WindowsIDToIANA(windowsID)
	}
	return SettingsSnapshot{
		Theme:           theme,
		DisplayTimeZone: zone,
		IANATimeZones:   timezoneadapter.IANAOptions(),
		SystemDark:      application.Get() != nil && application.Get().Env.IsDarkMode(),
	}, nil
}

func (s *SettingsService) SaveSettings(ctx context.Context, input SaveSettingsInput) (SettingsSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	defer release()
	if input.Theme != "light" && input.Theme != "dark" && input.Theme != "system" {
		return SettingsSnapshot{}, errors.New("invalid theme")
	}
	if _, err := timezoneadapter.LoadLocation(input.DisplayTimeZone); err != nil {
		return SettingsSnapshot{}, err
	}
	database, err := s.lifecycle.DB()
	if err != nil {
		return SettingsSnapshot{}, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return SettingsSnapshot{}, fmt.Errorf("begin display settings update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE display_settings SET theme = ?, display_timezone = ?, timezone_confirmed = 1 WHERE singleton = 1`, input.Theme, input.DisplayTimeZone); err != nil {
		return SettingsSnapshot{}, fmt.Errorf("update display settings: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SettingsSnapshot{}, fmt.Errorf("commit display settings update: %w", err)
	}
	snapshot, err := s.GetSettings(ctx)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	if app := application.Get(); app != nil {
		app.Event.Emit("settings:theme-changed", snapshot)
	}
	return snapshot, nil
}
