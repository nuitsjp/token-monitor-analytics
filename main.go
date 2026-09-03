package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"token-monitor-analytics/internal/adapter/backupzip"
	credentialadapter "token-monitor-analytics/internal/adapter/credential"
	"token-monitor-analytics/internal/adapter/hubapi"
	collectionscheduler "token-monitor-analytics/internal/adapter/scheduler"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	timezoneadapter "token-monitor-analytics/internal/adapter/timezone"
	"token-monitor-analytics/internal/desktop"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

const appVersion = "0.1.0"

type applicationStorage struct {
	dataDirectory string
	lifecycle     *sqliteadapter.Lifecycle
	recovery      domain.RestoreRecoveryResult
}

type applicationStorageDependencies struct {
	userConfigDir func() (string, error)
	mkdirAll      func(string, os.FileMode) error
	recover       func(context.Context, string) (domain.RestoreRecoveryResult, error)
	openLifecycle func(context.Context, string) (*sqliteadapter.Lifecycle, error)
}

func defaultApplicationStorageDependencies() applicationStorageDependencies {
	return applicationStorageDependencies{
		userConfigDir: os.UserConfigDir,
		mkdirAll:      os.MkdirAll,
		recover:       sqliteadapter.RecoverPendingRestore,
		openLifecycle: func(ctx context.Context, path string) (*sqliteadapter.Lifecycle, error) {
			lifecycle := &sqliteadapter.Lifecycle{}
			if err := lifecycle.Open(ctx, path); err != nil {
				return nil, err
			}
			return lifecycle, nil
		},
	}
}

func openApplicationStorage(ctx context.Context) (*applicationStorage, error) {
	return openApplicationStorageWithDependencies(ctx, defaultApplicationStorageDependencies())
}

func openApplicationStorageWithDependencies(ctx context.Context, dependencies applicationStorageDependencies) (*applicationStorage, error) {
	configDirectory, err := dependencies.userConfigDir()
	if err != nil {
		return nil, fmt.Errorf("resolve user configuration directory: %w", err)
	}
	dataDirectory := filepath.Join(configDirectory, "TokenMonitorAnalytics")
	if err := dependencies.mkdirAll(dataDirectory, 0o700); err != nil {
		return nil, fmt.Errorf("create application data directory: %w", err)
	}
	recovery, err := dependencies.recover(ctx, dataDirectory)
	if err != nil {
		return nil, err
	}
	lifecycle, err := dependencies.openLifecycle(ctx, filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName))
	if err != nil {
		return nil, err
	}
	return &applicationStorage{dataDirectory: dataDirectory, lifecycle: lifecycle, recovery: recovery}, nil
}

func (s *applicationStorage) Close() error {
	return s.lifecycle.Close()
}

type mainHubClient struct{ client *hubapi.Client }

func (c mainHubClient) FetchStats(ctx context.Context, secret string) (desktop.HubFetchResult, error) {
	result, err := c.client.FetchStats(ctx, secret)
	return desktop.HubFetchResult{Contract: desktop.HubContract{Build: desktop.HubBuildIdentity{
		SchemaVersion:   result.Contract.Build.SchemaVersion,
		Runtime:         result.Contract.Build.Runtime,
		CoreBuildID:     result.Contract.Build.CoreBuildID,
		RuntimeBuildID:  result.Contract.Build.RuntimeBuildID,
		CoreRevision:    result.Contract.Build.CoreRevision,
		RuntimeRevision: result.Contract.Build.RuntimeRevision,
	}}}, err
}

func mainHubClientFactory(rawURL string) (desktop.HubClient, error) {
	client, err := hubapi.NewClient(rawURL, hubapi.DefaultAllowlist)
	if err != nil {
		return nil, err
	}
	return mainHubClient{client: client}, nil
}

type mainCollectionClient struct{ client *hubapi.Client }

func (c mainCollectionClient) FetchStats(ctx context.Context, secret string) (usecase.CollectionResult, error) {
	result, err := c.client.FetchStats(ctx, secret)
	return usecase.CollectionResult{
		Health: usecase.CollectionResponse{Raw: result.Health.Raw, HTTPStatus: result.Health.HTTPStatus},
		Stats:  usecase.CollectionResponse{Raw: result.Stats.Raw, HTTPStatus: result.Stats.HTTPStatus},
		Contract: usecase.CollectionContract{
			Build: usecase.CollectionBuildIdentity{
				SchemaVersion: result.Contract.Build.SchemaVersion, Runtime: result.Contract.Build.Runtime,
				CoreBuildID: result.Contract.Build.CoreBuildID, RuntimeBuildID: result.Contract.Build.RuntimeBuildID,
				CoreRevision: result.Contract.Build.CoreRevision, RuntimeRevision: result.Contract.Build.RuntimeRevision,
			},
			UsageUpdatedAt: result.Contract.UsageUpdatedAt,
		},
	}, err
}

func mainCollectionClientFactory(rawURL string) (usecase.CollectionClient, error) {
	client, err := hubapi.NewClient(rawURL, hubapi.DefaultAllowlist)
	if err != nil {
		return nil, err
	}
	return mainCollectionClient{client: client}, nil
}

func mainCollectionDependencies() usecase.CollectionDependencies {
	return usecase.CollectionDependencies{
		NormalizeStats: func(raw []byte) (usecase.NormalizedStats, error) {
			result, err := hubapi.NormalizeStats(raw)
			if err != nil {
				return usecase.NormalizedStats{}, err
			}
			normalized := usecase.NormalizedStats{}
			for _, item := range result.Costs {
				normalized.Costs = append(normalized.Costs, usecase.NormalizedCostObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, CostUSDText: item.CostUSDText, SyncUploadIntervalMS: item.SyncUploadIntervalMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			for _, item := range result.Usage {
				normalized.Usage = append(normalized.Usage, usecase.NormalizedUsageObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, TokenCount: item.TokenCount, APICostUSDText: item.APICostUSDText, ModelTokens: item.ModelTokens, ModelCosts: item.ModelCosts, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			for _, item := range result.Limits {
				normalized.Limits = append(normalized.Limits, usecase.NormalizedLimitObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, AccountKey: item.AccountKey, AccountKeyKind: item.AccountKeyKind, AccountLabel: item.AccountLabel, AccountEmail: item.AccountEmail, ProviderUpdatedAt: item.ProviderUpdatedAt, WindowKey: item.WindowKey, NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric, NormalizedLabel: item.NormalizedLabel, PlanLabel: item.PlanLabel, UsedPercent: item.UsedPercent, AbsoluteUsedText: item.AbsoluteUsedText, AbsoluteLimitText: item.AbsoluteLimitText, AbsoluteRemainingText: item.AbsoluteRemainingText, Currency: item.Currency, ResetsAt: item.ResetsAt, SyncUploadIntervalMS: item.SyncUploadIntervalMS, LimitsRefreshMS: item.LimitsRefreshMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint, WindowKeyConflict: item.WindowKeyConflict})
			}
			for _, item := range result.Periods {
				normalized.Periods = append(normalized.Periods, usecase.NormalizedPeriodObservation{DeviceID: item.DeviceID, PeriodKind: item.PeriodKind, PeriodKey: item.PeriodKey, PeriodEndsAt: item.PeriodEndsAt, UsageUpdatedAt: item.UsageUpdatedAt, SourceTimezone: item.SourceTimezone, TokenCount: item.TokenCount, APICostUSDText: item.APICostUSDText, ToolTokens: item.ToolTokens, ToolCosts: item.ToolCosts, ModelTokens: item.ModelTokens, ModelCosts: item.ModelCosts, ToolModelTokens: item.ToolModelTokens, ToolModelCosts: item.ToolModelCosts, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			return normalized, nil
		},
		ClassifyError: func(err error) string {
			if classification := usecase.CollectionClassificationOf(err); classification != "" {
				return classification
			}
			return string(hubapi.ClassificationOf(err))
		},
		NormalizationGeneration:   hubapi.NormalizationGeneration,
		NormalizationRuleVersion:  hubapi.NormalizationRuleVersion,
		NormalizationLogicVersion: hubapi.NormalizationLogicVersion,
	}
}

type mainTimezoneProvider struct{}

func (mainTimezoneProvider) CurrentWindowsID() (string, error) {
	return timezoneadapter.CurrentWindowsID()
}
func (mainTimezoneProvider) WindowsIDToIANA(id string) (string, bool) {
	return timezoneadapter.WindowsIDToIANA(id)
}
func (mainTimezoneProvider) IANAOptions() []string { return timezoneadapter.IANAOptions() }
func (mainTimezoneProvider) LoadLocation(id string) (*time.Location, error) {
	return timezoneadapter.LoadLocation(id)
}

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
	reconciliation, err := usecase.NewReconciliationUsecase(storage.lifecycle, usecase.SystemClock{})
	if err != nil {
		return fmt.Errorf("start automatic reconciliation: %w", err)
	}
	if _, err := reconciliation.Reconcile(context.Background(), ""); err != nil {
		return fmt.Errorf("apply built-in catalog: %w", err)
	}
	renormalization, err := usecase.NewRenormalizationUsecase(storage.lifecycle, usecase.SystemClock{}, desktop.UUIDGenerator{}, mainCollectionDependencies())
	if err != nil {
		return fmt.Errorf("start raw snapshot renormalization: %w", err)
	}
	if _, err := renormalization.Run(context.Background()); err != nil {
		return fmt.Errorf("renormalize stored raw snapshots: %w", err)
	}
	if _, err := reconciliation.Reconcile(context.Background(), ""); err != nil {
		return fmt.Errorf("reconcile renormalized observations: %w", err)
	}
	settingsService := desktop.NewSettingsServiceWithDependencies(storage.lifecycle, mainTimezoneProvider{}, maintenanceGate)
	credentials := credentialadapter.Manager{}
	hubService := desktop.NewHubServiceWithClient(storage.lifecycle, credentials, usecase.SystemClock{}, desktop.UUIDGenerator{}, mainHubClientFactory, maintenanceGate)
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
	usageService, err := desktop.NewUsageServiceWithDependencies(storage.lifecycle, usecase.SystemClock{}, mainTimezoneProvider{})
	if err != nil {
		return fmt.Errorf("start usage service: %w", err)
	}
	recalculationWorker, err := usecase.NewRecalculationWorker(storage.lifecycle, "desktop-worker")
	if err != nil {
		return fmt.Errorf("start recalculation worker: %w", err)
	}
	recalcCtx, cancelRecalc := context.WithCancel(context.Background())
	defer cancelRecalc()
	triggerRecalc := make(chan struct{}, 1)
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-recalcCtx.Done():
				return
			case <-ticker.C:
			case <-triggerRecalc:
			}
			for {
				claimed, err := recalculationWorker.RunOnce(recalcCtx)
				if err != nil || !claimed || recalcCtx.Err() != nil {
					break
				}
			}
		}
	}()
	select {
	case triggerRecalc <- struct{}{}:
	default:
	}

	collector, err := usecase.NewCollectionUsecase(
		storage.lifecycle,
		credentials,
		mainCollectionClientFactory,
		usecase.SystemClock{},
		desktop.UUIDGenerator{},
		func() usecase.CollectionDependencies {
			dependencies := mainCollectionDependencies()
			dependencies.AfterSuccessfulCollection = func(ctx context.Context, hubID string) error {
				if _, err := reconciliation.Reconcile(ctx, hubID); err != nil {
					return err
				}
				select {
				case triggerRecalc <- struct{}{}:
				default:
				}
				return nil
			}
			return dependencies
		}(),
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
			application.NewService(usageService),
			application.NewService(dataManagementService),
		},
	})
	windowController.Attach(app)
	desktop.RegisterThemeSync(app, settingsService)

	compact := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                "compact",
		Title:               "Token Monitor Analytics",
		Width:               360,
		Height:              360,
		MinWidth:            320,
		MinHeight:           160,
		AlwaysOnTop:         true,
		Frameless:           true,
		MinimiseButtonState: application.ButtonDisabled,
		MaximiseButtonState: application.ButtonDisabled,
		BackgroundType:      application.BackgroundTypeTransparent,
		URL:                 "/?window=compact",
		Windows: application.WindowsWindow{
			DisableFramelessWindowDecorations: true,
		},
	})
	windowController.SetCompact(compact)

	if err := app.Run(); err != nil {
		return fmt.Errorf("run Wails application: %w", err)
	}
	return nil
}
