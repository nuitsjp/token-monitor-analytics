package desktop

import (
	"context"
	"testing"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/usecase"
)

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
