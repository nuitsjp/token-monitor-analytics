package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	credentialadapter "token-monitor-analytics/internal/adapter/credential"
	"token-monitor-analytics/internal/adapter/hubapi"
	collectionscheduler "token-monitor-analytics/internal/adapter/scheduler"
	"token-monitor-analytics/internal/desktop"
	"token-monitor-analytics/internal/usecase"
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
	credentials := credentialadapter.Manager{}
	hubService := desktop.NewHubService(storage.lifecycle, credentials)
	auditService := desktop.NewAuditService(storage.lifecycle)
	catalogService, err := desktop.NewCatalogService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start catalog service: %w", err)
	}
	accountService, err := desktop.NewAccountService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start account service: %w", err)
	}
	reviewService, err := desktop.NewReviewService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start review service: %w", err)
	}
	collector, err := usecase.NewCollectionUsecase(
		storage.lifecycle,
		credentials,
		func(rawURL string, allowlist hubapi.Allowlist) (usecase.CollectionClient, error) {
			return hubapi.NewClient(rawURL, allowlist)
		},
		usecase.SystemClock{},
		desktop.UUIDGenerator{},
		hubapi.DefaultAllowlist,
	)
	if err != nil {
		return fmt.Errorf("start collection usecase: %w", err)
	}
	collectionScheduler, err := collectionscheduler.New(collector, storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start collection scheduler: %w", err)
	}
	if err := collectionScheduler.Restore(context.Background()); err != nil {
		return fmt.Errorf("restore collection scheduler: %w", err)
	}
	defer func() {
		runErr = errors.Join(runErr, collectionScheduler.Close())
	}()
	collectionService, err := desktop.NewCollectionService(storage.lifecycle, collectionScheduler)
	if err != nil {
		return fmt.Errorf("start collection service: %w", err)
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
			application.NewService(accountService),
			application.NewService(collectionService),
			application.NewService(reviewService),
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
