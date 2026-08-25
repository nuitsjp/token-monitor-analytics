package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	credentialadapter "token-monitor-analytics/internal/adapter/credential"
	"token-monitor-analytics/internal/desktop"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() (runErr error) {
	storage, err := openApplicationStorage(context.Background())
	if err != nil {
		return fmt.Errorf("start storage: %w", err)
	}
	defer func() {
		runErr = errors.Join(runErr, storage.Close())
	}()

	windowService, windowController := desktop.NewWindowService(storage.lifecycle)
	settingsService := desktop.NewSettingsService(storage.lifecycle)
	hubService := desktop.NewHubService(storage.lifecycle, credentialadapter.Manager{})
	auditService := desktop.NewAuditService(storage.lifecycle)
	catalogService, err := desktop.NewCatalogService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start catalog service: %w", err)
	}
	app := application.New(application.Options{
		Name:        "Token Monitor Analytics",
		Description: "Local-first analytics for Token Monitor hubs",
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Services: []application.Service{
			application.NewService(windowService),
			application.NewService(settingsService),
			application.NewService(hubService),
			application.NewService(auditService),
			application.NewService(catalogService),
		},
	})
	windowController.Attach(app)
	desktop.RegisterThemeSync(app, settingsService)

	compact := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                "compact",
		Title:               "Token Monitor Analytics",
		Width:               360,
		Height:              180,
		MinWidth:            320,
		MinHeight:           160,
		AlwaysOnTop:         true,
		MinimiseButtonState: application.ButtonDisabled,
		MaximiseButtonState: application.ButtonDisabled,
		BackgroundColour:    application.NewRGB(250, 250, 250),
		URL:                 "/?window=compact",
	})
	windowController.SetCompact(compact)

	if err := app.Run(); err != nil {
		return fmt.Errorf("run Wails application: %w", err)
	}
	return nil
}
