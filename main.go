package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"token-monitor-analytics/internal/adapter/backupzip"
	credentialadapter "token-monitor-analytics/internal/adapter/credential"
	"token-monitor-analytics/internal/adapter/hubapi"
	collectionscheduler "token-monitor-analytics/internal/adapter/scheduler"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/desktop"
	"token-monitor-analytics/internal/usecase"
)

const appVersion = "0.1.0"

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
	maintenanceGate := usecase.NewMaintenanceGate()
	settingsService := desktop.NewSettingsService(storage.lifecycle, maintenanceGate)
	credentials := credentialadapter.Manager{}
	hubService := desktop.NewHubService(storage.lifecycle, credentials, maintenanceGate)
	auditService := desktop.NewAuditService(storage.lifecycle)
	catalogService, err := desktop.NewCatalogService(storage.lifecycle, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start catalog service: %w", err)
	}
	accountService, err := desktop.NewAccountService(storage.lifecycle, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start account service: %w", err)
	}
	reviewService, err := desktop.NewReviewService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start review service: %w", err)
	}
	estimationService, err := desktop.NewEstimationService(storage.lifecycle)
	if err != nil {
		return fmt.Errorf("start estimation service: %w", err)
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
		maintenanceGate,
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
	backupWriter, err := backupzip.NewWriter()
	if err != nil {
		return fmt.Errorf("start backup writer: %w", err)
	}
	backupUsecase, err := usecase.NewBackupUsecase(storage.lifecycle, backupWriter, nil, usecase.SystemClock{}, appVersion, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start backup usecase: %w", err)
	}
	purgeUsecase, err := usecase.NewPurgeUsecase(storage.lifecycle, usecase.SystemClock{}, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start purge usecase: %w", err)
	}
	restoreValidation, err := usecase.NewRestoreValidationUsecase(storage.lifecycle, backupzip.NewValidator(), nil, usecase.SystemClock{}, desktop.UUIDGenerator{}, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start restore validation: %w", err)
	}
	defer func() {
		runErr = errors.Join(runErr, restoreValidation.Close())
	}()
	restoreApplier, err := sqliteadapter.NewRestoreApplier(storage.lifecycle, nil)
	if err != nil {
		return fmt.Errorf("start restore applier: %w", err)
	}
	restoreApply, err := usecase.NewRestoreApplyUsecase(restoreValidation, restoreApplier, collectionScheduler, usecase.SystemClock{}, desktop.UUIDGenerator{}, maintenanceGate)
	if err != nil {
		return fmt.Errorf("start restore apply usecase: %w", err)
	}
	dataManagementService, err := desktop.NewDataManagementService(purgeUsecase, backupUsecase, restoreValidation, restoreApply, maintenanceGate, storage.recovery, appVersion, sqliteadapter.CurrentSchemaVersion)
	if err != nil {
		return fmt.Errorf("start data management service: %w", err)
	}
	windowController.SetMaintenanceReader(dataManagementService)
	overviewService, err := desktop.NewOverviewServiceWithMaintenance(storage.lifecycle, storage.recovery, dataManagementService)
	if err != nil {
		return fmt.Errorf("start overview service: %w", err)
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
			application.NewService(overviewService),
			application.NewService(estimationService),
			application.NewService(dataManagementService),
		},
	})
	windowController.Attach(app)
	desktop.RegisterThemeSync(app, settingsService)

	compact := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                "compact",
		Title:               "Token Monitor Analytics",
		Width:               360,
		Height:              220,
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
