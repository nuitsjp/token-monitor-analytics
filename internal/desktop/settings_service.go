package desktop

import (
	"context"
	"errors"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type SettingsSnapshot struct {
	Theme             string   `json:"theme"`
	DisplayTimeZone   string   `json:"displayTimeZone"`
	IANATimeZones     []string `json:"ianaTimeZones"`
	TimezoneConfirmed bool     `json:"timezoneConfirmed"`
	SystemDark        bool     `json:"systemDark"`
}

type SaveSettingsInput struct {
	Theme           string `json:"theme"`
	DisplayTimeZone string `json:"displayTimeZone"`
}

type SettingsService struct {
	repository SettingsRepository
	timezone   TimezoneProvider
	gate       *usecase.MaintenanceGate
}

type SettingsRepository interface {
	GetDisplaySettings(context.Context) (domain.DisplaySettings, error)
	UpdateDisplaySettings(context.Context, string, string) error
}

type TimezoneProvider interface {
	CurrentWindowsID() (string, error)
	WindowsIDToIANA(string) (string, bool)
	IANAOptions() []string
	LoadLocation(string) (*time.Location, error)
}

type systemTimezoneProvider struct{}

func (systemTimezoneProvider) CurrentWindowsID() (string, error) {
	return "", errors.New("windows timezone is unavailable")
}
func (systemTimezoneProvider) WindowsIDToIANA(string) (string, bool) { return "", false }
func (systemTimezoneProvider) IANAOptions() []string                 { return nil }
func (systemTimezoneProvider) LoadLocation(id string) (*time.Location, error) {
	return time.LoadLocation(id)
}

func NewSettingsService(repository SettingsRepository, gate *usecase.MaintenanceGate) *SettingsService {
	return NewSettingsServiceWithDependencies(repository, systemTimezoneProvider{}, gate)
}

func NewSettingsServiceWithDependencies(repository SettingsRepository, timezone TimezoneProvider, gate *usecase.MaintenanceGate) *SettingsService {
	return &SettingsService{repository: repository, timezone: timezone, gate: gate}
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
	settings, err := s.repository.GetDisplaySettings(ctx)
	if err != nil {
		return SettingsSnapshot{}, err
	}
	zone := ""
	if settings.TimezoneConfirmed && settings.DisplayTimezone != "" {
		zone = settings.DisplayTimezone
	} else if windowsID, err := s.timezone.CurrentWindowsID(); err == nil {
		zone, _ = s.timezone.WindowsIDToIANA(windowsID)
	}
	return SettingsSnapshot{
		Theme:             settings.Theme,
		DisplayTimeZone:   zone,
		IANATimeZones:     s.timezone.IANAOptions(),
		TimezoneConfirmed: settings.TimezoneConfirmed,
		SystemDark:        application.Get() != nil && application.Get().Env.IsDarkMode(),
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
	if _, err := s.timezone.LoadLocation(input.DisplayTimeZone); err != nil {
		return SettingsSnapshot{}, err
	}
	if err := s.repository.UpdateDisplaySettings(ctx, input.Theme, input.DisplayTimeZone); err != nil {
		return SettingsSnapshot{}, err
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
