package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestInsertObservationsRollsBackBothKindsTogether(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	if err := lifecycle.CreateHub(ctx, Hub{ID: hubID, DisplayName: "Hub", URL: "https://hub.example.test", CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: "attempt", HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: "stats", AttemptID: "attempt", HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now.Add(time.Second), HTTPStatus: 200, Body: []byte(`{"devices":[]}`)}); err != nil {
		t.Fatal(err)
	}
	cost := CostObservation{ObservationID: "cost", SnapshotID: "stats", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "codex", UsageUpdatedAt: now, CostUSDText: "1", AnalyticsIntervalSeconds: 300, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", JSONPath: "$.devices[0]", DedupeKey: "same", ValueFingerprint: "fingerprint"}
	limit := LimitObservation{ObservationID: "limit", SnapshotID: "stats", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "codex", ProviderUpdatedAt: now, DedupeKey: "same-limit", ValueFingerprint: "fingerprint"}
	if err := lifecycle.InsertObservations(ctx, []CostObservation{cost}, []LimitObservation{limit}); err == nil {
		t.Fatal("InsertObservations succeeded with invalid limit")
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(context.Background(), `SELECT count(*) FROM usage_cost_observations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("cost observations = %d, want 0 after rollback", count)
	}
}

func TestInsertAllObservationsPersistsPhaseTwoUsageAndNativeAmounts(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	if err := lifecycle.CreateHub(ctx, Hub{ID: hubID, DisplayName: "Hub", URL: "https://usage.example.test", CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: "usage-attempt", HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: "usage-stats", AttemptID: "usage-attempt", HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now, HTTPStatus: 200, Body: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	usage := UsageObservation{ObservationID: "usage-observation", UsageCostSourceID: "usage-source", SnapshotID: "usage-stats", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "codex", UsageUpdatedAt: now, TokenCount: 120, APICostUSDText: "2.75", ModelTokens: map[string]int64{"gpt-5": 120}, ModelCosts: map[string]string{"gpt-5": "2.75"}, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", JSONPath: "$.periods.allTime", DedupeKey: "usage-key", ValueFingerprint: "usage-value"}
	limit := LimitObservation{ObservationID: "native-amount", UsageLimitSourceID: "limit-source", SnapshotID: "usage-stats", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "codex", ProviderUpdatedAt: now, WindowKey: "balance", NormalizedKind: "balance", NormalizedMetric: "credits", NormalizedLabel: "Credits", AbsoluteUsedText: "58", AbsoluteLimitText: "100", AbsoluteRemainingText: "42", Currency: "CREDITS", AnalyticsIntervalSeconds: 300, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", JSONPath: "$.limits[0]", DedupeKey: "native-key", ValueFingerprint: "native-value"}
	if err := lifecycle.InsertAllObservations(ctx, nil, []UsageObservation{usage}, []LimitObservation{limit}); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListUsageAnalysisObservations(ctx)
	if err != nil || len(rows) != 1 || rows[0].TokenCount != 120 || rows[0].ModelTokens["gpt-5"] != 120 {
		t.Fatalf("P2-USAGE-01 rows=%#v err=%v", rows, err)
	}
	amounts, err := lifecycle.ListUsageNativeAmounts(ctx)
	if err != nil || len(amounts) != 1 || amounts[0].RemainingText != "42" || amounts[0].Currency != "CREDITS" {
		t.Fatalf("P2-USAGE-06 amounts=%#v err=%v", amounts, err)
	}
}

func TestObservationDedupeNeverCrossesHub(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	var costs []CostObservation
	for index := 1; index <= 2; index++ {
		hubID := uuid.NewString()
		if err := lifecycle.CreateHub(ctx, Hub{ID: hubID, DisplayName: "Hub", URL: "https://hub.example.test/" + hubID, CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now.Add(time.Duration(index) * time.Second), UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		attemptID, snapshotID := "attempt-"+hubID, "stats-"+hubID
		if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now, HTTPStatus: 200, Body: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
		costs = append(costs, CostObservation{ObservationID: "cost-" + hubID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: "codex", UsageUpdatedAt: now, CostUSDText: "1", AnalyticsIntervalSeconds: 300, NormalizationGeneration: 1, NormalizationRuleVersion: "rule", NormalizationLogicVersion: "logic", JSONPath: "$.devices[0]", DedupeKey: "same", ValueFingerprint: "same-value"})
	}
	if err := lifecycle.InsertCostObservations(ctx, costs); err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	rows, err := database.QueryContext(context.Background(), `SELECT hub_id, dedupe_state FROM usage_cost_observations ORDER BY hub_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	count := 0
	for rows.Next() {
		var hubID, state string
		if err := rows.Scan(&hubID, &state); err != nil {
			t.Fatal(err)
		}
		if state != "canonical" {
			t.Fatalf("state = %s, want canonical", state)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	t.Run("DM-OBS-03 dedupe never crosses Hub boundaries", func(t *testing.T) {
		if count != 2 {
			t.Fatalf("cost observations = %d, want 2", count)
		}
	})
	duplicate := costs[0]
	duplicate.ObservationID = "cost-duplicate"
	if err := lifecycle.InsertCostObservations(ctx, []CostObservation{duplicate}); err != nil {
		t.Fatal(err)
	}
	t.Run("DM-OBS-01 repeated identical cost observation keeps one canonical value", func(t *testing.T) {
		var canonical, duplicateState int
		if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM usage_cost_observations WHERE hub_id = ? AND dedupe_key = ? AND dedupe_state = 'canonical'`, duplicate.HubID, duplicate.DedupeKey).Scan(&canonical); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM usage_cost_observations WHERE hub_id = ? AND dedupe_key = ? AND dedupe_state = 'duplicate'`, duplicate.HubID, duplicate.DedupeKey).Scan(&duplicateState); err != nil {
			t.Fatal(err)
		}
		if canonical != 1 || duplicateState != 1 {
			t.Fatalf("dedupe states canonical=%d duplicate=%d", canonical, duplicateState)
		}
	})
	conflict := costs[0]
	conflict.ObservationID = "cost-conflict"
	conflict.CostUSDText = "2"
	conflict.ValueFingerprint = "different-value"
	if err := lifecycle.InsertCostObservations(ctx, []CostObservation{conflict}); err != nil {
		t.Fatal(err)
	}
	t.Run("API-COST-06 conflicting value at one usage timestamp is unusable", func(t *testing.T) {
		var states int
		if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM usage_cost_observations WHERE hub_id = ? AND dedupe_key = ? AND dedupe_state = 'conflict'`, conflict.HubID, conflict.DedupeKey).Scan(&states); err != nil {
			t.Fatal(err)
		}
		if states != 3 {
			t.Fatalf("conflict rows = %d, want 3", states)
		}
	})
	t.Run("DM-OBS-02 conflicting cost observations are marked conflict", func(t *testing.T) {
		var state string
		if err := database.QueryRowContext(t.Context(), `SELECT dedupe_state FROM usage_cost_observations WHERE observation_id = ?`, conflict.ObservationID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "conflict" {
			t.Fatalf("conflict observation state = %q", state)
		}
	})
}
