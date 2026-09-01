package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"token-monitor-analytics/internal/adapter/hubapi"
	"token-monitor-analytics/internal/usecase"
)

type renormalizationTestClock struct{ now time.Time }

func (c renormalizationTestClock) Now() time.Time { return c.now }

type renormalizationTestIDs struct{}

func (renormalizationTestIDs) New() string { return uuid.NewString() }

func TestStoredRawSnapshotsAreRenormalizedWithDeviceUpdatedAt(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 7, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	if err := lifecycle.CreateHub(ctx, Hub{ID: hubID, DisplayName: "Hub", URL: "https://renormalize.example.test", CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: "raw-attempt", HubID: hubID, Trigger: "manual", State: "succeeded", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	raw := `{"devices":[{"deviceId":"device","updatedAt":"2026-09-02T07:00:00Z","periods":{"allTime":{"clientCosts":{"codex":1.5}}},"limits":{"refreshMs":300000,"providers":[{"provider":"codex","accountKey":"account","accountLabel":"Pro 5x","updatedAt":"2026-09-02T06:59:00Z","windows":[{"limitId":"weekly","kind":"weekly","metric":"percent","label":"Weekly","usedPercent":25,"resetsAt":"2026-09-09T00:00:00Z"}]}]}}]}`
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: "raw-stats", AttemptID: "raw-attempt", HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now, HTTPStatus: 200, APIContract: "schema=1;runtime=node-hub;core_revision=23", Body: []byte(raw)}); err != nil {
		t.Fatal(err)
	}
	dependencies := usecase.CollectionDependencies{
		NormalizationGeneration: hubapi.NormalizationGeneration, NormalizationRuleVersion: hubapi.NormalizationRuleVersion, NormalizationLogicVersion: hubapi.NormalizationLogicVersion,
		NormalizeStats: func(raw []byte) (usecase.NormalizedStats, error) {
			value, err := hubapi.NormalizeStats(raw)
			if err != nil {
				return usecase.NormalizedStats{}, err
			}
			result := usecase.NormalizedStats{}
			for _, item := range value.Costs {
				result.Costs = append(result.Costs, usecase.NormalizedCostObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, UsageUpdatedAt: item.UsageUpdatedAt, CostUSDText: item.CostUSDText, SyncUploadIntervalMS: item.SyncUploadIntervalMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			for _, item := range value.Limits {
				result.Limits = append(result.Limits, usecase.NormalizedLimitObservation{DeviceID: item.DeviceID, RawServiceIdentifier: item.RawServiceIdentifier, AccountKey: item.AccountKey, ProviderUpdatedAt: item.ProviderUpdatedAt, WindowKey: item.WindowKey, NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric, NormalizedLabel: item.NormalizedLabel, PlanLabel: item.PlanLabel, UsedPercent: item.UsedPercent, ResetsAt: item.ResetsAt, SyncUploadIntervalMS: item.SyncUploadIntervalMS, LimitsRefreshMS: item.LimitsRefreshMS, SourceTimezone: item.SourceTimezone, SourceLocalDate: item.SourceLocalDate, JSONPath: item.JSONPath, DedupeKey: item.DedupeKey, ValueFingerprint: item.ValueFingerprint})
			}
			return result, nil
		},
	}
	renormalization, err := usecase.NewRenormalizationUsecase(lifecycle, renormalizationTestClock{now: now.Add(time.Minute)}, renormalizationTestIDs{}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	count, err := renormalization.Run(ctx)
	if err != nil || count != 1 {
		t.Fatalf("renormalized=%d err=%v", count, err)
	}
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	var costs, limits, active, histories int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_cost_observations WHERE normalization_generation = ? AND usage_updated_at = '2026-09-02T07:00:00Z'`, hubapi.NormalizationGeneration).Scan(&costs); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_limit_observations WHERE normalization_generation = ? AND plan_label = 'Pro 5x' AND window_key = 'weekly'||char(31)||'percent'||char(31)||'Weekly'`, hubapi.NormalizationGeneration).Scan(&limits); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM normalization_runs WHERE snapshot_id = 'raw-stats' AND state = 'active'`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM plan_histories`).Scan(&histories); err != nil {
		t.Fatal(err)
	}
	if costs != 1 || limits != 1 || active != 1 || histories != 1 {
		t.Fatalf("costs=%d limits=%d active=%d histories=%d", costs, limits, active, histories)
	}
}
