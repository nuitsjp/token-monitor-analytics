package usecase

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"token-monitor-analytics/internal/adapter/hubapi"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

type CollectionStore interface {
	GetHubRow(context.Context, string) (sqliteadapter.HubRow, error)
	ListCredentialAuditEvents(context.Context, string) ([]sqliteadapter.CredentialAuditEvent, error)
	SetHubCollectionEnabled(context.Context, string, bool, time.Time) error
	CreateCollectionAttempt(context.Context, sqliteadapter.CollectionAttempt) error
	FinishCollectionAttempt(context.Context, sqliteadapter.CollectionAttempt) error
	SaveRawSnapshots(context.Context, []sqliteadapter.RawSnapshot) error
	InsertObservations(context.Context, []sqliteadapter.CostObservation, []sqliteadapter.LimitObservation) error
}

type CredentialReader interface {
	Read(hubID string) (secret string, found bool, err error)
}

type CollectionClient interface {
	FetchStats(context.Context, string) (hubapi.Result, error)
}

type CollectionClientFactory func(rawURL string, allowlist hubapi.Allowlist) (CollectionClient, error)

type CollectionUsecase struct {
	store       CollectionStore
	credentials CredentialReader
	factory     CollectionClientFactory
	clock       Clock
	ids         IDGenerator
	allowlist   hubapi.Allowlist
	gate        *MaintenanceGate
	mu          sync.Mutex
	active      map[string]struct{}
}

func NewCollectionUsecase(store CollectionStore, credentials CredentialReader, factory CollectionClientFactory, clock Clock, ids IDGenerator, allowlist hubapi.Allowlist, gate *MaintenanceGate) (*CollectionUsecase, error) {
	if store == nil || credentials == nil || factory == nil || clock == nil || ids == nil || gate == nil {
		return nil, errors.New("collection usecase dependencies are required")
	}
	return &CollectionUsecase{store: store, credentials: credentials, factory: factory, clock: clock, ids: ids, allowlist: allowlist, gate: gate, active: make(map[string]struct{})}, nil
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
		attempt := sqliteadapter.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "hub_disabled"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record disabled Hub collection: %w", err)
		}
		return nil
	}
	if trigger == "scheduled" && !row.Hub.CollectionEnabled {
		completed := u.clock.Now().UTC()
		attempt := sqliteadapter.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "collection_disabled"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record disabled collection: %w", err)
		}
		return nil
	}
	if !u.acquire(hubID) {
		completed := u.clock.Now().UTC()
		attempt := sqliteadapter.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "skipped", StartedAt: started, CompletedAt: &completed, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds, FailureCode: "duplicate_in_flight"}
		if err := u.recordSkipped(ctx, attempt); err != nil {
			return fmt.Errorf("record skipped collection: %w", err)
		}
		return nil
	}
	defer u.release(hubID)

	attempt := sqliteadapter.CollectionAttempt{AttemptID: u.ids.New(), HubID: hubID, Trigger: trigger, State: "started", StartedAt: started, AnalyticsIntervalSeconds: row.Hub.CollectionIntervalSeconds}
	if err := u.store.CreateCollectionAttempt(ctx, attempt); err != nil {
		return fmt.Errorf("start collection attempt: %w", err)
	}
	result, collectErr := u.fetch(ctx, row)
	completed := u.clock.Now().UTC()
	attempt.CompletedAt = &completed
	attempt.HealthHTTPStatus = nonZeroStatus(result.Health.HTTPStatus)
	attempt.StatsHTTPStatus = nonZeroStatus(result.Stats.HTTPStatus)
	attempt.APIContract = contractText(result.Contract)

	var snapshots []sqliteadapter.RawSnapshot
	if len(result.Health.Raw) > 0 && result.Health.HTTPStatus > 0 {
		attempt.HealthSnapshotID = u.ids.New()
		snapshots = append(snapshots, sqliteadapter.RawSnapshot{SnapshotID: attempt.HealthSnapshotID, AttemptID: attempt.AttemptID, HubID: hubID, ResponseKind: "health", ReceivedStartedAt: started, ReceivedCompletedAt: completed, HTTPStatus: result.Health.HTTPStatus, APIContract: attempt.APIContract, Body: result.Health.Raw})
	}
	if collectErr == nil && len(result.Stats.Raw) > 0 && result.Stats.HTTPStatus > 0 {
		attempt.StatsSnapshotID = u.ids.New()
		snapshots = append(snapshots, sqliteadapter.RawSnapshot{SnapshotID: attempt.StatsSnapshotID, AttemptID: attempt.AttemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: started, ReceivedCompletedAt: completed, HTTPStatus: result.Stats.HTTPStatus, APIContract: attempt.APIContract, Body: result.Stats.Raw})
	}
	if len(snapshots) > 0 {
		if err := u.store.SaveRawSnapshots(ctx, snapshots); err != nil {
			attempt.State, attempt.FailureCode, attempt.FailureDetail = "failed", "storage", "raw snapshot could not be saved"
			_ = u.store.FinishCollectionAttempt(ctx, attempt)
			return fmt.Errorf("save raw snapshots: %w", err)
		}
	}
	if collectErr != nil {
		attempt.State, attempt.FailureCode, attempt.FailureDetail = "failed", string(hubapi.ClassificationOf(collectErr)), safeFailureDetail(collectErr)
		if attempt.FailureCode == "" {
			attempt.FailureCode = "collection"
		}
		if err := u.store.FinishCollectionAttempt(ctx, attempt); err != nil {
			return fmt.Errorf("record collection failure: %w", err)
		}
		return nil
	}

	normalized, normalizeErr := hubapi.NormalizeStats(result.Stats.Raw)
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
	attempt.State = "succeeded"
	if err := u.store.FinishCollectionAttempt(ctx, attempt); err != nil {
		return fmt.Errorf("record collection success: %w", err)
	}
	return nil
}

func (u *CollectionUsecase) fetch(ctx context.Context, row sqliteadapter.HubRow) (hubapi.Result, error) {
	events, err := u.store.ListCredentialAuditEvents(ctx, row.Hub.ID)
	if err != nil {
		return hubapi.Result{}, errors.New("credential state could not be read")
	}
	if domain.DeriveCredentialState(toCredentialEvents(events)) != domain.CredentialRegistered {
		return hubapi.Result{}, &hubapi.Error{Classification: hubapi.ClassificationAuth, Operation: "stats", Reason: "credential is not ready"}
	}
	client, err := u.factory(row.Hub.URL, u.allowlist)
	if err != nil {
		return hubapi.Result{}, err
	}
	secret, found, err := u.credentials.Read(row.Hub.ID)
	if err != nil {
		return hubapi.Result{}, errors.New("credential could not be read")
	}
	if !found {
		return hubapi.Result{}, &hubapi.Error{Classification: hubapi.ClassificationAuth, Operation: "stats", Reason: "credential is not registered"}
	}
	result, err := client.FetchStats(ctx, secret)
	secret = ""
	return result, err
}

func (u *CollectionUsecase) saveObservations(ctx context.Context, normalized hubapi.NormalizedStats, attempt sqliteadapter.CollectionAttempt) error {
	costs := make([]sqliteadapter.CostObservation, 0, len(normalized.Costs))
	for _, item := range normalized.Costs {
		costs = append(costs, sqliteadapter.CostObservation{ObservationID: u.ids.New(), UsageCostSourceID: u.ids.New(), SnapshotID: attempt.StatsSnapshotID, HubID: attempt.HubID, DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, CostUSDText: item.CostUSDText, SyncUploadIntervalMS: item.SyncUploadIntervalMS, AnalyticsIntervalSeconds: attempt.AnalyticsIntervalSeconds, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, NormalizationGeneration: hubapi.NormalizationGeneration, NormalizationRuleVersion: hubapi.NormalizationRuleVersion, NormalizationLogicVersion: hubapi.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
	}
	limits := make([]sqliteadapter.LimitObservation, 0, len(normalized.Limits))
	for _, item := range normalized.Limits {
		limits = append(limits, sqliteadapter.LimitObservation{ObservationID: u.ids.New(), UsageLimitSourceID: u.ids.New(), HubAccountCandidateID: u.ids.New(), IdentificationCandidateID: u.ids.New(), SnapshotID: attempt.StatsSnapshotID, HubID: attempt.HubID, DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, AccountKey: item.AccountKey, ProviderUpdatedAt: item.ProviderUpdatedAt, WindowKey: item.WindowKey, NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric, NormalizedLabel: item.NormalizedLabel, PlanLabel: item.PlanLabel, UsedPercent: item.UsedPercent, ResetsAt: item.ResetsAt, SyncUploadIntervalMS: item.SyncUploadIntervalMS, LimitsRefreshMS: item.LimitsRefreshMS, AnalyticsIntervalSeconds: attempt.AnalyticsIntervalSeconds, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, NormalizationGeneration: hubapi.NormalizationGeneration, NormalizationRuleVersion: hubapi.NormalizationRuleVersion, NormalizationLogicVersion: hubapi.NormalizationLogicVersion, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint, WindowKeyConflict: item.WindowKeyConflict})
	}
	return u.store.InsertObservations(ctx, costs, limits)
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

func (u *CollectionUsecase) recordSkipped(ctx context.Context, attempt sqliteadapter.CollectionAttempt) error {
	if err := u.store.CreateCollectionAttempt(ctx, attempt); err != nil {
		return err
	}
	return u.store.FinishCollectionAttempt(ctx, attempt)
}

func contractText(contract hubapi.Contract) string {
	if !contract.UsageUpdatedAt {
		return ""
	}
	return fmt.Sprintf("schema=%d;runtime=%s;core=%s;runtime_build=%s", contract.Build.SchemaVersion, contract.Build.Runtime, contract.Build.CoreBuildID, contract.Build.RuntimeBuildID)
}

func safeFailureDetail(err error) string {
	if classified := hubapi.ClassificationOf(err); classified != "" {
		return string(classified)
	}
	return "collection failed"
}

func nonZeroStatus(value int) *int {
	if value <= 0 {
		return nil
	}
	return &value
}

func toCredentialEvents(events []sqliteadapter.CredentialAuditEvent) []domain.CredentialEvent {
	result := make([]domain.CredentialEvent, 0, len(events))
	for _, event := range events {
		result = append(result, domain.CredentialEvent{Sequence: event.Sequence, Action: event.Action})
	}
	return result
}
