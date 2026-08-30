package desktop

import (
	"context"
	"errors"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/usecase"
)

type settingsTimezoneFake struct {
	windowsID  string
	currentErr error
	mappings   map[string]string
	options    []string
	loadErr    error
	loaded     []string
}

func (f *settingsTimezoneFake) CurrentWindowsID() (string, error) {
	return f.windowsID, f.currentErr
}

func (f *settingsTimezoneFake) WindowsIDToIANA(id string) (string, bool) {
	value, ok := f.mappings[id]
	return value, ok
}

func (f *settingsTimezoneFake) IANAOptions() []string {
	return append([]string(nil), f.options...)
}

func (f *settingsTimezoneFake) LoadLocation(id string) (*time.Location, error) {
	f.loaded = append(f.loaded, id)
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	return time.LoadLocation(id)
}

func TestSettingsServicePersistsExplicitTimezoneConfirmation(t *testing.T) {
	ctx := context.Background()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, t.TempDir()+"/settings.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })

	service := NewSettingsService(lifecycle, usecase.NewMaintenanceGate())
	initial, err := service.GetSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.TimezoneConfirmed {
		t.Fatalf("new settings unexpectedly confirmed: %#v", initial)
	}

	saved, err := service.SaveSettings(ctx, SaveSettingsInput{
		Theme:           initial.Theme,
		DisplayTimeZone: "UTC",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !saved.TimezoneConfirmed || saved.DisplayTimeZone != "UTC" {
		t.Fatalf("saved settings = %#v", saved)
	}
}

func TestSettingsServiceQLTIME01UsesWindowsTimezoneUntilUserConfirmsIANA(t *testing.T) {
	ctx := context.Background()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, t.TempDir()+"/settings.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	provider := &settingsTimezoneFake{
		windowsID: "Tokyo Standard Time",
		mappings:  map[string]string{"Tokyo Standard Time": "Asia/Tokyo"},
		options:   []string{"Asia/Tokyo", "UTC"},
	}
	service := NewSettingsServiceWithDependencies(lifecycle, provider, usecase.NewMaintenanceGate())

	initial, err := service.GetSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.TimezoneConfirmed || initial.DisplayTimeZone != "Asia/Tokyo" {
		t.Fatalf("initial settings = %#v", initial)
	}
	if len(initial.IANATimeZones) != 2 || initial.IANATimeZones[0] != "Asia/Tokyo" {
		t.Fatalf("IANA options = %v", initial.IANATimeZones)
	}

	saved, err := service.SaveSettings(ctx, SaveSettingsInput{Theme: "dark", DisplayTimeZone: "UTC"})
	if err != nil {
		t.Fatal(err)
	}
	if !saved.TimezoneConfirmed || saved.DisplayTimeZone != "UTC" || saved.Theme != "dark" {
		t.Fatalf("saved settings = %#v", saved)
	}
	if len(provider.loaded) != 1 || provider.loaded[0] != "UTC" {
		t.Fatalf("loaded timezones = %v", provider.loaded)
	}
}

func TestSettingsServiceRejectsInvalidThemeAndTimezoneBeforePersistence(t *testing.T) {
	ctx := context.Background()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, t.TempDir()+"/settings.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	wantLoadErr := errors.New("unsupported IANA timezone")
	provider := &settingsTimezoneFake{loadErr: wantLoadErr}
	service := NewSettingsServiceWithDependencies(lifecycle, provider, usecase.NewMaintenanceGate())

	if _, err := service.SaveSettings(ctx, SaveSettingsInput{Theme: "sepia", DisplayTimeZone: "UTC"}); err == nil {
		t.Fatal("invalid theme was accepted")
	}
	if len(provider.loaded) != 0 {
		t.Fatalf("timezone was loaded for invalid theme: %v", provider.loaded)
	}
	if _, err := service.SaveSettings(ctx, SaveSettingsInput{Theme: "dark", DisplayTimeZone: "Invalid/Zone"}); !errors.Is(err, wantLoadErr) {
		t.Fatalf("invalid timezone error = %v", err)
	}
	settings, err := lifecycle.GetDisplaySettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if settings.TimezoneConfirmed || settings.Theme != "system" {
		t.Fatalf("invalid settings were persisted: %#v", settings)
	}
}

func TestSettingsServiceLeavesUnconfirmedTimezoneBlankWhenWindowsLookupFails(t *testing.T) {
	ctx := context.Background()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, t.TempDir()+"/settings.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	provider := &settingsTimezoneFake{currentErr: errors.New("Windows timezone unavailable")}
	service := NewSettingsServiceWithDependencies(lifecycle, provider, usecase.NewMaintenanceGate())

	snapshot, err := service.GetSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TimezoneConfirmed || snapshot.DisplayTimeZone != "" {
		t.Fatalf("fallback settings = %#v", snapshot)
	}
}
