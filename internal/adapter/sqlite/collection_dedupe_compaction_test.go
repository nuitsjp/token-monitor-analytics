package sqlite

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

// These tests specify the storage contract for compacted normalized
// observations. A raw snapshot remains one row per collection, while an exact
// normalized value is represented by one row in its normalized observation
// table. first_seen_at and last_seen_at are the receive times of the first and
// latest snapshots, respectively; the representative snapshot is stable and
// points to the first snapshot, while latest_snapshot_id follows the newest
// one.
type collectionDedupeCompactionCase struct {
	name   string
	table  string
	insert func(context.Context, *Lifecycle, string, string, string, time.Time, int64, string, int64) error
}

func collectionDedupeCompactionCases() []collectionDedupeCompactionCase {
	return []collectionDedupeCompactionCase{
		{
			name:  "cost",
			table: "usage_cost_observations",
			insert: func(ctx context.Context, lifecycle *Lifecycle, observationID, snapshotID, hubID string, observedAt time.Time, generation int64, fingerprint string, value int64) error {
				return lifecycle.InsertCostObservations(ctx, []CostObservation{{
					ObservationID: observationID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device",
					RawServiceIdentifier: "service.cost", UsageUpdatedAt: observedAt, CostUSDText: fmt.Sprint(value),
					AnalyticsIntervalSeconds: 300, NormalizationGeneration: generation,
					NormalizationRuleVersion: "rule-v1", NormalizationLogicVersion: "logic-v1", JSONPath: "$.cost",
					DedupeKey: "same-key", ValueFingerprint: fingerprint,
				}})
			},
		},
		{
			name:  "usage",
			table: "usage_analysis_observations",
			insert: func(ctx context.Context, lifecycle *Lifecycle, observationID, snapshotID, hubID string, observedAt time.Time, generation int64, fingerprint string, value int64) error {
				return lifecycle.InsertAllObservations(ctx, nil, []UsageObservation{{
					ObservationID: observationID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device",
					RawServiceIdentifier: "service.usage", UsageUpdatedAt: observedAt, TokenCount: value,
					APICostUSDText: fmt.Sprint(value), ModelTokens: map[string]int64{"model": value},
					ModelCosts:              map[string]string{"model": fmt.Sprint(value)},
					NormalizationGeneration: generation, NormalizationRuleVersion: "rule-v1",
					NormalizationLogicVersion: "logic-v1", JSONPath: "$.usage", DedupeKey: "same-key",
					ValueFingerprint: fingerprint,
				}}, nil)
			},
		},
		{
			name:  "limit",
			table: "usage_limit_observations",
			insert: func(ctx context.Context, lifecycle *Lifecycle, observationID, snapshotID, hubID string, observedAt time.Time, generation int64, fingerprint string, value int64) error {
				usedPercent := float64(value)
				return lifecycle.InsertLimitObservations(ctx, []LimitObservation{{
					ObservationID: observationID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device",
					RawServiceIdentifier: "service.limit", AccountKey: "account", ProviderUpdatedAt: observedAt,
					WindowKey: "weekly", NormalizedKind: "weekly", NormalizedMetric: "percent",
					NormalizedLabel: "Weekly", PlanLabel: "Plan", UsedPercent: &usedPercent,
					AnalyticsIntervalSeconds: 300, NormalizationGeneration: generation,
					NormalizationRuleVersion: "rule-v1", NormalizationLogicVersion: "logic-v1",
					JSONPath: "$.limit", DedupeKey: "same-key", ValueFingerprint: fingerprint,
				}})
			},
		},
	}
}

func createCollectionCompactionHub(t *testing.T, lifecycle *Lifecycle, ctx context.Context, hubID string, now time.Time) {
	t.Helper()
	if err := lifecycle.CreateHub(ctx, Hub{
		ID: hubID, DisplayName: hubID, URL: "https://" + hubID + ".example.test",
		CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

func saveCollectionCompactionSnapshot(t *testing.T, lifecycle *Lifecycle, ctx context.Context, attemptID, snapshotID, hubID string, receivedAt time.Time) {
	t.Helper()
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{
		AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: receivedAt,
		AnalyticsIntervalSeconds: 300,
	}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{
		SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats",
		ReceivedStartedAt: receivedAt, ReceivedCompletedAt: receivedAt, HTTPStatus: 200, Body: []byte(`{}`),
	}); err != nil {
		t.Fatal(err)
	}
}

func queryCompactedObservation(t *testing.T, ctx context.Context, lifecycle *Lifecycle, table, hubID, dedupeKey string, generation int64) (int, int64, string, string, string, string, string) {
	t.Helper()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRowContext(ctx, "SELECT count(*) FROM "+table+" WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ?", hubID, dedupeKey, generation).Scan(&count); err != nil {
		t.Fatal(err)
	}
	var seenCount int64
	var firstSeenAt, lastSeenAt, representativeSnapshotID, latestSnapshotID, dedupeState string
	err = database.QueryRowContext(ctx, "SELECT seen_count, first_seen_at, last_seen_at, representative_snapshot_id, latest_snapshot_id, dedupe_state FROM "+table+" WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ?", hubID, dedupeKey, generation).Scan(&seenCount, &firstSeenAt, &lastSeenAt, &representativeSnapshotID, &latestSnapshotID, &dedupeState)
	if err != nil {
		t.Fatal(err)
	}
	return count, seenCount, firstSeenAt, lastSeenAt, representativeSnapshotID, latestSnapshotID, dedupeState
}

func TestCollectionDedupeCompactionAggregatesExactNormalizedObservations(t *testing.T) {
	for _, testCase := range collectionDedupeCompactionCases() {
		t.Run(testCase.name, func(t *testing.T) {
			lifecycle := openTestLifecycle(t)
			ctx := context.Background()
			firstSeen := time.Date(2026, 9, 2, 10, 0, 0, 0, time.UTC)
			lastSeen := firstSeen.Add(5 * time.Minute)
			hubID := uuid.NewString()
			createCollectionCompactionHub(t, lifecycle, ctx, hubID, firstSeen)
			saveCollectionCompactionSnapshot(t, lifecycle, ctx, "attempt-first-"+testCase.name, "snapshot-first-"+testCase.name, hubID, firstSeen)
			saveCollectionCompactionSnapshot(t, lifecycle, ctx, "attempt-last-"+testCase.name, "snapshot-last-"+testCase.name, hubID, lastSeen)

			if err := testCase.insert(ctx, lifecycle, "observation-first-"+testCase.name, "snapshot-first-"+testCase.name, hubID, firstSeen, 1, "same-value", 25); err != nil {
				t.Fatal(err)
			}
			if err := testCase.insert(ctx, lifecycle, "observation-last-"+testCase.name, "snapshot-last-"+testCase.name, hubID, firstSeen, 1, "same-value", 25); err != nil {
				t.Fatal(err)
			}

			count, seenCount, firstSeenAt, lastSeenAt, representativeSnapshotID, latestSnapshotID, state := queryCompactedObservation(t, ctx, lifecycle, testCase.table, hubID, "same-key", 1)
			if count != 1 {
				t.Fatalf("compacted rows = %d, want 1", count)
			}
			if seenCount != 2 {
				t.Fatalf("seen_count = %d, want 2", seenCount)
			}
			if firstSeenAt != utcText(firstSeen) || lastSeenAt != utcText(lastSeen) {
				t.Fatalf("seen range = (%q, %q), want (%q, %q)", firstSeenAt, lastSeenAt, utcText(firstSeen), utcText(lastSeen))
			}
			if representativeSnapshotID != "snapshot-first-"+testCase.name || latestSnapshotID != "snapshot-last-"+testCase.name {
				t.Fatalf("snapshots representative=%q latest=%q", representativeSnapshotID, latestSnapshotID)
			}
			if state != "canonical" {
				t.Fatalf("dedupe_state = %q, want canonical", state)
			}
		})
	}
}

func TestCollectionDedupeCompactionKeepsConflictingValuesAsSeparateRows(t *testing.T) {
	for _, testCase := range collectionDedupeCompactionCases() {
		t.Run(testCase.name, func(t *testing.T) {
			lifecycle := openTestLifecycle(t)
			ctx := context.Background()
			now := time.Date(2026, 9, 2, 11, 0, 0, 0, time.UTC)
			hubID := uuid.NewString()
			createCollectionCompactionHub(t, lifecycle, ctx, hubID, now)
			saveCollectionCompactionSnapshot(t, lifecycle, ctx, "attempt-a-"+testCase.name, "snapshot-a-"+testCase.name, hubID, now)
			saveCollectionCompactionSnapshot(t, lifecycle, ctx, "attempt-b-"+testCase.name, "snapshot-b-"+testCase.name, hubID, now.Add(time.Minute))

			if err := testCase.insert(ctx, lifecycle, "observation-a-"+testCase.name, "snapshot-a-"+testCase.name, hubID, now, 1, "value-a", 25); err != nil {
				t.Fatal(err)
			}
			if err := testCase.insert(ctx, lifecycle, "observation-b-"+testCase.name, "snapshot-b-"+testCase.name, hubID, now, 1, "value-b", 50); err != nil {
				t.Fatal(err)
			}

			database, err := lifecycle.DB()
			if err != nil {
				t.Fatal(err)
			}
			var count, conflicts int
			if err := database.QueryRowContext(ctx, "SELECT count(*) FROM "+testCase.table+" WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ?", hubID, "same-key", 1).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if err := database.QueryRowContext(ctx, "SELECT count(*) FROM "+testCase.table+" WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? AND dedupe_state = 'conflict'", hubID, "same-key", 1).Scan(&conflicts); err != nil {
				t.Fatal(err)
			}
			if count != 2 || conflicts != 2 {
				t.Fatalf("conflicting rows = %d, conflict states = %d, want 2 and 2", count, conflicts)
			}
		})
	}
}

func TestCollectionDedupeCompactionDoesNotCrossHubOrGeneration(t *testing.T) {
	for _, testCase := range collectionDedupeCompactionCases() {
		t.Run(testCase.name, func(t *testing.T) {
			lifecycle := openTestLifecycle(t)
			ctx := context.Background()
			now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
			hubA, hubB := uuid.NewString(), uuid.NewString()
			createCollectionCompactionHub(t, lifecycle, ctx, hubA, now)
			createCollectionCompactionHub(t, lifecycle, ctx, hubB, now)

			observations := []struct {
				hubID, suffix, snapshotID string
				generation                int64
			}{
				{hubID: hubA, suffix: "a1", snapshotID: "snapshot-a1-" + testCase.name, generation: 1},
				{hubID: hubA, suffix: "a2", snapshotID: "snapshot-a2-" + testCase.name, generation: 2},
				{hubID: hubB, suffix: "b1", snapshotID: "snapshot-b1-" + testCase.name, generation: 1},
			}
			for _, observation := range observations {
				saveCollectionCompactionSnapshot(t, lifecycle, ctx, "attempt-"+observation.suffix+"-"+testCase.name, observation.snapshotID, observation.hubID, now)
				if err := testCase.insert(ctx, lifecycle, "observation-"+observation.suffix+"-"+testCase.name, observation.snapshotID, observation.hubID, now, observation.generation, "same-value", 25); err != nil {
					t.Fatal(err)
				}
			}

			database, err := lifecycle.DB()
			if err != nil {
				t.Fatal(err)
			}
			var count int
			if err := database.QueryRowContext(ctx, "SELECT count(*) FROM "+testCase.table+" WHERE dedupe_key = ?", "same-key").Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 3 {
				t.Fatalf("rows sharing dedupe key = %d, want 3 (Hub and generation are part of scope)", count)
			}
			rows, err := database.QueryContext(ctx, "SELECT hub_id, normalization_generation, seen_count, dedupe_state FROM "+testCase.table+" WHERE dedupe_key = ? ORDER BY hub_id, normalization_generation", "same-key")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = rows.Close() }()
			wantRows := []struct {
				hubID      string
				generation int64
			}{
				{hubID: hubA, generation: 1},
				{hubID: hubA, generation: 2},
				{hubID: hubB, generation: 1},
			}
			sort.Slice(wantRows, func(i, j int) bool {
				if wantRows[i].hubID == wantRows[j].hubID {
					return wantRows[i].generation < wantRows[j].generation
				}
				return wantRows[i].hubID < wantRows[j].hubID
			})
			for index, want := range wantRows {
				if !rows.Next() {
					t.Fatalf("row %d missing", index)
				}
				var hubID, state string
				var generation, seenCount int64
				if err := rows.Scan(&hubID, &generation, &seenCount, &state); err != nil {
					t.Fatal(err)
				}
				if hubID != want.hubID || generation != want.generation || seenCount != 1 || state != "canonical" {
					t.Fatalf("row %d = (%q, %d, %d, %q), want (%q, %d, 1, canonical)", index, hubID, generation, seenCount, state, want.hubID, want.generation)
				}
			}
			if rows.Next() {
				t.Fatal("unexpected fourth row for same dedupe key")
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPurgeKeepsCompactedObservationWhenAnotherOccurrenceSurvives(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	firstSeen := time.Date(2026, 9, 2, 13, 0, 0, 0, time.UTC)
	lastSeen := firstSeen.Add(5 * time.Minute)
	hubID := uuid.NewString()
	createCollectionCompactionHub(t, lifecycle, ctx, hubID, firstSeen)
	saveCollectionCompactionSnapshot(t, lifecycle, ctx, "purge-attempt-first", "purge-snapshot-first", hubID, firstSeen)
	saveCollectionCompactionSnapshot(t, lifecycle, ctx, "purge-attempt-last", "purge-snapshot-last", hubID, lastSeen)

	insert := collectionDedupeCompactionCases()[0].insert
	if err := insert(ctx, lifecycle, "purge-observation-first", "purge-snapshot-first", hubID, firstSeen, 1, "same-value", 25); err != nil {
		t.Fatal(err)
	}
	if err := insert(ctx, lifecycle, "purge-observation-last", "purge-snapshot-last", hubID, firstSeen, 1, "same-value", 25); err != nil {
		t.Fatal(err)
	}

	start, end := firstSeen.Add(-time.Second), firstSeen.Add(time.Second)
	if _, err := lifecycle.Purge(ctx, domain.PurgeSelection{HubIDs: []string{hubID}, Start: &start, End: &end}, lastSeen.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	count, seenCount, firstSeenAt, lastSeenAt, representativeSnapshotID, latestSnapshotID, state := queryCompactedObservation(t, ctx, lifecycle, "usage_cost_observations", hubID, "same-key", 1)
	if count != 1 || seenCount != 1 || state != "canonical" {
		t.Fatalf("surviving compacted observation count=%d seen=%d state=%q", count, seenCount, state)
	}
	if firstSeenAt != utcText(lastSeen) || lastSeenAt != utcText(lastSeen) {
		t.Fatalf("surviving seen range=(%q,%q), want %q", firstSeenAt, lastSeenAt, utcText(lastSeen))
	}
	if representativeSnapshotID != "purge-snapshot-last" || latestSnapshotID != "purge-snapshot-last" {
		t.Fatalf("surviving snapshots representative=%q latest=%q", representativeSnapshotID, latestSnapshotID)
	}
}
