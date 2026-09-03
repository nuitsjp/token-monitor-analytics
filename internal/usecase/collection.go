package usecase

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"token-monitor-analytics/internal/domain"
)

type CollectionStore interface {
	GetHubRow(context.Context, string) (domain.HubRow, error)
	ListCredentialAuditEvents(context.Context, string) ([]domain.CredentialAuditEvent, error)
	SetHubCollectionEnabled(context.Context, string, bool, time.Time) error
	CreateCollectionAttempt(context.Context, domain.CollectionAttempt) error
	FinishCollectionAttempt(context.Context, domain.CollectionAttempt) error
	SaveRawSnapshots(context.Context, []domain.RawSnapshot) error
	InsertAllObservations(context.Context, []domain.CostObservation, []domain.CollectionUsageObservation, []domain.LimitObservation, []domain.CollectionUsagePeriodObservation) error
}

type CredentialReader interface {
	Read(hubID string) (secret string, found bool, err error)
}

type CollectionClient interface {
	FetchStats(context.Context, string) (CollectionResult, error)
}

type CollectionClientFactory func(rawURL string) (CollectionClient, error)

type CollectionResponse struct {
	Raw        []byte
	HTTPStatus int
}

type CollectionResult struct {
	Health   CollectionResponse
	Stats    CollectionResponse
	Contract CollectionContract
}

type CollectionContract struct {
	Build          CollectionBuildIdentity
	UsageUpdatedAt bool
}

type CollectionBuildIdentity struct {
	SchemaVersion   int
	Runtime         string
	CoreBuildID     string
	RuntimeBuildID  string
	CoreRevision    int
	RuntimeRevision int
}

type NormalizedCostObservation struct {
	DeviceID             string
	RawServiceIdentifier string
	UsageUpdatedAt       time.Time
	CostUSDText          string
	SyncUploadIntervalMS *int64
	SourceTimezone       string
	SourceLocalDate      string
	JSONPath             string
	DedupeKey            string
	ValueFingerprint     string
}

type NormalizedUsageObservation struct {
	DeviceID             string
	RawServiceIdentifier string
	UsageUpdatedAt       time.Time
	TokenCount           int64
	APICostUSDText       string
	ModelTokens          map[string]int64
	ModelCosts           map[string]string
	SourceTimezone       string
	SourceLocalDate      string
	JSONPath             string
	DedupeKey            string
	ValueFingerprint     string
}

type NormalizedLimitObservation struct {
	DeviceID              string
	RawServiceIdentifier  string
	AccountKey            string
	AccountKeyKind        string
	AccountLabel          string
	AccountEmail          string
	ProviderUpdatedAt     time.Time
	WindowKey             string
	NormalizedKind        string
	NormalizedMetric      string
	NormalizedLabel       string
	PlanLabel             string
	UsedPercent           *float64
	AbsoluteUsedText      string
	AbsoluteLimitText     string
	AbsoluteRemainingText string
	Currency              string
	ResetsAt              *time.Time
	SyncUploadIntervalMS  *int64
	LimitsRefreshMS       *int64
	SourceTimezone        string
	SourceLocalDate       string
	JSONPath              string
	DedupeKey             string
	ValueFingerprint      string
	WindowKeyConflict     bool
}

type NormalizedPeriodObservation struct {
	DeviceID         string
	PeriodKind       string
	PeriodKey        string
	PeriodEndsAt     time.Time
	UsageUpdatedAt   time.Time
	SourceTimezone   string
	TokenCount       int64
	APICostUSDText   string
	ToolTokens       map[string]int64
	ToolCosts        map[string]string
	ModelTokens      map[string]int64
	ModelCosts       map[string]string
	ToolModelTokens  map[string]map[string]int64
	ToolModelCosts   map[string]map[string]string
	JSONPath         string
	DedupeKey        string
	ValueFingerprint string
}

type NormalizedStats struct {
	Costs   []NormalizedCostObservation
	Usage   []NormalizedUsageObservation
	Limits  []NormalizedLimitObservation
	Periods []NormalizedPeriodObservation
}

type CollectionDependencies struct {
	NormalizeStats            func([]byte) (NormalizedStats, error)
	ClassifyError             func(error) string
	AfterSuccessfulCollection func(context.Context, string) error
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
}

type CollectionError struct {
	Classification string
	Reason         string
}

func (e *CollectionError) Error() string { return e.Reason }

func CollectionClassificationOf(err error) string {
	var classified *CollectionError
	if errors.As(err, &classified) {
		return classified.Classification
	}
	return ""
}

type CollectionUsecase struct {
	store        CollectionStore
	credentials  CredentialReader
	factory      CollectionClientFactory
	clock        Clock
	ids          IDGenerator
	dependencies CollectionDependencies
	gate         *MaintenanceGate
	mu           sync.Mutex
	active       map[string]struct{}
}

func NewCollectionUsecase(store CollectionStore, credentials CredentialReader, factory CollectionClientFactory, clock Clock, ids IDGenerator, dependencies CollectionDependencies, gate *MaintenanceGate) (*CollectionUsecase, error) {
	if store == nil || credentials == nil || factory == nil || clock == nil || ids == nil || gate == nil || dependencies.NormalizeStats == nil || dependencies.ClassifyError == nil {
		return nil, errors.New("collection usecase dependencies are required")
	}
	return &CollectionUsecase{store: store, credentials: credentials, factory: factory, clock: clock, ids: ids, dependencies: dependencies, gate: gate, active: make(map[string]struct{})}, nil
}

func (u *CollectionUsecase) StartCollection(ctx context.Context, hubID string) error {
	lease, err := u.gate.Acquire(ctx, MaintenanceCollection)
	if err != nil {
		return err
	}
	defer lease.Release()
	row, err := u.store.GetHubRow(ctx, hubID)
	if err != nil {
		return err
	}
	if !row.Hub.Enabled {
		return errors.New("disabled Hub cannot start collection")
	}
	events, err := u.store.ListCredentialAuditEvents(ctx, hubID)
	if err != nil {
		return errors.New("credential state could not be read")
	}
	if domain.DeriveCredentialState(toCredentialEvents(events)) != domain.CredentialRegistered {
		return errors.New("hub credential must be registered before collection starts")
	}
	return u.store.SetHubCollectionEnabled(ctx, hubID, true, u.clock.Now().UTC())
}

func (u *CollectionUsecase) StopCollection(ctx context.Context, hubID string) error {
	lease, err := u.gate.Acquire(ctx, MaintenanceCollection)
	if err != nil {
		return err
	}
	defer lease.Release()
	return u.store.SetHubCollectionEnabled(ctx, hubID, false, u.clock.Now().UTC())
}

func (u *CollectionUsecase) CollectNow(ctx context.Context, hubID string) error {
	lease, err := u.gate.Acquire(ctx, MaintenanceCollection)
	if err != nil {
		return err
	}
	defer lease.Release()
	return u.collect(ctx, hubID, "manual")
}

func (u *CollectionUsecase) CollectScheduled(ctx context.Context, hubID string) error {
	lease, err := u.gate.Acquire(ctx, MaintenanceCollection)
	if err != nil {
		return err
	}
	defer lease.Release()
	return u.collect(ctx, hubID, "scheduled")
}

func (u *CollectionUsecase) collect(ctx context.Context, hubID, trigger string) error {
	if trigger != "manual" && trigger != "scheduled" {
		return errors.New("collection trigger is invalid")
	}
	row, err := u.store.GetHubRow(ctx, hubID)
	if err != nil {
		return err
	}
	started := u.clock.Now().UTC()
	if !row.Hub.Enabled {
		completed := u.clock.Now().UTC()
		attempt := domain.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "hub_disabled"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record disabled Hub collection: %w", err)
		}
		return nil
	}
	if trigger == "scheduled" && !row.Hub.CollectionEnabled {
		completed := u.clock.Now().UTC()
		attempt := domain.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "collection_disabled"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record disabled collection: %w", err)
		}
		return nil
	}
	if !u.acquire(hubID) {
		completed := u.clock.Now().UTC()
		attempt := domain.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "duplicate_in_flight"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record skipped collection: %w", err)
		}
		return nil
	}
	defer u.release(hubID)

	attempt := domain.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "started", StartedAt: started, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds}
	if err := u.store.CreateCollectionAttempt(ctx, attempt); err != nil {
		return fmt.Errorf("start collection attempt: %w", err)
	}
	result, collectErr := u.fetch(ctx, row)
	completed := u.clock.Now().UTC()
	attempt.CompletedAt = &completed
	attempt.HealthHTTPStatus = nonZeroStatus(result.Health.HTTPStatus)
	attempt.StatsHTTPStatus = nonZeroStatus(result.Stats.HTTPStatus)
	attempt.APIContract = contractText(result.Contract)

	var snapshots []domain.RawSnapshot
	if len(result.Health.Raw) > 0 && result.Health.HTTPStatus > 0 {
		attempt.HealthSnapshotID = u.ids.New()
		snapshots = append(snapshots, domain.RawSnapshot{SnapshotID: attempt.HealthSnapshotID, AttemptID: attempt.AttemptID, HubID: hubID, ResponseKind: "health", ReceivedStartedAt: started, ReceivedCompletedAt: completed, HTTPStatus: result.Health.HTTPStatus, APIContract: attempt.APIContract, Body: result.Health.Raw})
	}
	if collectErr == nil && len(result.Stats.Raw) > 0 && result.Stats.HTTPStatus > 0 {
		attempt.StatsSnapshotID = u.ids.New()
		snapshots = append(snapshots, domain.RawSnapshot{SnapshotID: attempt.StatsSnapshotID, AttemptID: attempt.AttemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: started, ReceivedCompletedAt: completed, HTTPStatus: result.Stats.HTTPStatus, APIContract: attempt.APIContract, Body: result.Stats.Raw})
	}
	if len(snapshots) > 0 {
		if err := u.store.SaveRawSnapshots(ctx, snapshots); err != nil {
			attempt.State, attempt.FailureCode, attempt.FailureDetail = "failed", "storage", "raw snapshot could not be saved"
			_ = u.store.FinishCollectionAttempt(ctx, attempt)
			return fmt.Errorf("save raw snapshots: %w", err)
		}
	}
	if collectErr != nil {
		attempt.State, attempt.FailureCode, attempt.FailureDetail = "failed", u.dependencies.ClassifyError(collectErr), safeFailureDetail(collectErr, u.dependencies.ClassifyError)
		if attempt.FailureCode == "" {
			attempt.FailureCode = "collection"
		}
		if err := u.store.FinishCollectionAttempt(ctx, attempt); err != nil {
			return fmt.Errorf("record collection failure: %w", err)
		}
		return nil
	}

	normalized, normalizeErr := u.dependencies.NormalizeStats(result.Stats.Raw)
	if normalizeErr != nil {
		attempt.State, attempt.FailureCode, attempt.FailureDetail, attempt.NormalizationErrorPath = "failed", "normalization_failed", "stats normalization failed", "$"
		if err := u.store.FinishCollectionAttempt(ctx, attempt); err != nil {
			return fmt.Errorf("record normalization failure: %w", err)
		}
		return nil
	}
	if err := u.saveObservations(ctx, normalized, attempt); err != nil {
		attempt.State, attempt.FailureCode, attempt.FailureDetail, attempt.NormalizationErrorPath = "failed", "normalization_failed", "normalized observations could not be saved", "$"
		_ = u.store.FinishCollectionAttempt(ctx, attempt)
		return fmt.Errorf("save normalized observations: %w", err)
	}
	if u.dependencies.AfterSuccessfulCollection != nil {
		if err := u.dependencies.AfterSuccessfulCollection(ctx, hubID); err != nil {
			attempt.State, attempt.FailureCode, attempt.FailureDetail = "failed", "automatic_reconciliation_failed", "automatic configuration reconciliation failed"
			_ = u.store.FinishCollectionAttempt(ctx, attempt)
			return fmt.Errorf("reconcile collected observations: %w", err)
		}
	}
	attempt.State = "succeeded"
	if err := u.store.FinishCollectionAttempt(ctx, attempt); err != nil {
		return fmt.Errorf("record collection success: %w", err)
	}
	return nil
}

func (u *CollectionUsecase) fetch(ctx context.Context, row domain.HubRow) (CollectionResult, error) {
	events, err := u.store.ListCredentialAuditEvents(ctx, row.Hub.ID)
	if err != nil {
		return CollectionResult{}, errors.New("credential state could not be read")
	}
	if domain.DeriveCredentialState(toCredentialEvents(events)) != domain.CredentialRegistered {
		return CollectionResult{}, &CollectionError{Classification: "auth", Reason: "credential is not ready"}
	}
	client, err := u.factory(row.Hub.URL)
	if err != nil {
		return CollectionResult{}, err
	}
	secret, found, err := u.credentials.Read(row.Hub.ID)
	if err != nil {
		return CollectionResult{}, errors.New("credential could not be read")
	}
	if !found {
		return CollectionResult{}, &CollectionError{Classification: "auth", Reason: "credential is not registered"}
	}
	result, err := client.FetchStats(ctx, secret)
	return result, err
}

func (u *CollectionUsecase) saveObservations(ctx context.Context, normalized NormalizedStats, attempt domain.CollectionAttempt) error {
	batch := buildObservationBatch(normalized, attempt.StatsSnapshotID, attempt.HubID, attempt.AnalyticsIntervalSeconds, u.ids, u.dependencies)
	return u.store.InsertAllObservations(ctx, batch.costs, batch.usage, batch.limits, batch.periods)
}

type observationBatch struct {
	costs   []domain.CostObservation
	usage   []domain.CollectionUsageObservation
	limits  []domain.LimitObservation
	periods []domain.CollectionUsagePeriodObservation
}

func buildObservationBatch(normalized NormalizedStats, snapshotID, hubID string, analyticsIntervalSeconds int64, ids IDGenerator, dependencies CollectionDependencies) observationBatch {
	costs := make([]domain.CostObservation, 0, len(normalized.Costs))
	for _, item := range normalized.Costs {
		costs = append(costs, domain.CostObservation{ObservationID: ids.New(), UsageCostSourceID: ids.New(), SnapshotID: snapshotID, HubID: hubID, DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, CostUSDText: item.CostUSDText, SyncUploadIntervalMS: item.SyncUploadIntervalMS, AnalyticsIntervalSeconds: analyticsIntervalSeconds, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, NormalizationGeneration: dependencies.NormalizationGeneration, NormalizationRuleVersion: dependencies.NormalizationRuleVersion, NormalizationLogicVersion: dependencies.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
	}
	usage := make([]domain.CollectionUsageObservation, 0, len(normalized.Usage))
	for _, item := range normalized.Usage {
		usage = append(usage, domain.CollectionUsageObservation{ObservationID: ids.New(), UsageCostSourceID: ids.New(), SnapshotID: snapshotID, HubID: hubID, DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, TokenCount: item.TokenCount, APICostUSDText: item.APICostUSDText, ModelTokens: item.ModelTokens, ModelCosts: item.ModelCosts, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, NormalizationGeneration: dependencies.NormalizationGeneration, NormalizationRuleVersion: dependencies.NormalizationRuleVersion, NormalizationLogicVersion: dependencies.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
	}
	limits := make([]domain.LimitObservation, 0, len(normalized.Limits))
	for _, item := range normalized.Limits {
		limits = append(limits, domain.LimitObservation{ObservationID: ids.New(), UsageLimitSourceID: ids.New(), HubAccountCandidateID: ids.New(), IdentificationCandidateID: ids.New(), SnapshotID: snapshotID, HubID: hubID, DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, AccountKey: item.AccountKey, AccountKeyKind: item.AccountKeyKind, AccountDisplayName: item.AccountLabel, AccountEmail: item.AccountEmail, ProviderUpdatedAt: item.ProviderUpdatedAt, WindowKey: item.WindowKey, NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric, NormalizedLabel: item.NormalizedLabel, PlanLabel: item.PlanLabel, UsedPercent: item.UsedPercent, AbsoluteUsedText: item.AbsoluteUsedText, AbsoluteLimitText: item.AbsoluteLimitText, AbsoluteRemainingText: item.AbsoluteRemainingText, Currency: item.Currency, ResetsAt: item.ResetsAt, SyncUploadIntervalMS: item.SyncUploadIntervalMS, LimitsRefreshMS: item.LimitsRefreshMS, AnalyticsIntervalSeconds: analyticsIntervalSeconds, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, NormalizationGeneration: dependencies.NormalizationGeneration, NormalizationRuleVersion: dependencies.NormalizationRuleVersion, NormalizationLogicVersion: dependencies.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint, WindowKeyConflict: item.WindowKeyConflict})
	}
	periods := make([]domain.CollectionUsagePeriodObservation, 0, len(normalized.Periods))
	for _, item := range normalized.Periods {
		periods = append(periods, domain.CollectionUsagePeriodObservation{ObservationID: ids.New(), SnapshotID: snapshotID, HubID: hubID, DeviceID: item.DeviceID, PeriodKind: item.PeriodKind, PeriodKey: item.PeriodKey, PeriodEndsAt: item.PeriodEndsAt, UsageUpdatedAt: item.UsageUpdatedAt, SourceTimezone: item.SourceTimezone, TokenCount: item.TokenCount, APICostUSDText: item.APICostUSDText, ToolTokens: item.ToolTokens, ToolCosts: item.ToolCosts, ModelTokens: item.ModelTokens, ModelCosts: item.ModelCosts, ToolModelTokens: item.ToolModelTokens, ToolModelCosts: item.ToolModelCosts, NormalizationGeneration: dependencies.NormalizationGeneration, NormalizationRuleVersion: dependencies.NormalizationRuleVersion, NormalizationLogicVersion: dependencies.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
	}
	return observationBatch{costs: costs, usage: usage, limits: limits, periods: periods}
}

func (u *CollectionUsecase) acquire(hubID string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if _, exists := u.active[hubID]; exists {
		return false
	}
	u.active[hubID] = struct{}{}
	return true
}

func (u *CollectionUsecase) release(hubID string) {
	u.mu.Lock()
	delete(u.active, hubID)
	u.mu.Unlock()
}

func (u *CollectionUsecase) recordSkipped(ctx context.Context, attempt domain.CollectionAttempt) error {
	if err := u.store.CreateCollectionAttempt(ctx, attempt); err != nil {
		return err
	}
	return u.store.FinishCollectionAttempt(ctx, attempt)
}

func contractText(contract CollectionContract) string {
	if contract.Build.SchemaVersion <= 0 {
		return ""
	}
	return fmt.Sprintf("schema=%d;runtime=%s;core_revision=%d;runtime_revision=%d;core=%s;runtime_build=%s;usage_observation_time=%t", contract.Build.SchemaVersion, contract.Build.Runtime, contract.Build.CoreRevision, contract.Build.RuntimeRevision, contract.Build.CoreBuildID, contract.Build.RuntimeBuildID, contract.UsageUpdatedAt)
}

func safeFailureDetail(err error, classify func(error) string) string {
	if classified := classify(err); classified != "" {
		return classified
	}
	return "collection failed"
}

func nonZeroStatus(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

func toCredentialEvents(events []domain.CredentialAuditEvent) []domain.CredentialEvent {
	result := make([]domain.CredentialEvent, 0, len(events))
	for _, event := range events {
		result = append(result, domain.CredentialEvent(event))
	}
	return result
}
