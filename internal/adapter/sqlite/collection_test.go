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
	if err := database.QueryRow(`SELECT count(*) FROM usage_cost_observations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("cost observations = %d, want 0 after rollback", count)
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
	rows, err := database.Query(`SELECT hub_id, dedupe_state FROM usage_cost_observations ORDER BY hub_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
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
	if count != 2 {
		t.Fatalf("cost observations = %d, want 2", count)
	}
}
