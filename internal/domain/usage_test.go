package domain

import (
	"testing"
	"time"
)

func TestDeriveUsageDeltasKeepsDistinctHubsAndSharedAttribution(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	observations := []UsageObservation{
		{ID: "a-1", SnapshotID: "a-s1", SourceID: "source-a", HubID: "hub-a", ObservedAt: start, TokenCount: 100, APICostUSDText: "1.25", ModelTokens: map[string]int64{"gpt-5": 100}, ModelCosts: map[string]string{"gpt-5": "1.25"}, AccountIDs: []string{"one", "two"}, CompletenessConfirmed: true},
		{ID: "a-2", SnapshotID: "a-s2", SourceID: "source-a", HubID: "hub-a", ObservedAt: start.Add(time.Hour), TokenCount: 180, APICostUSDText: "2.5", ModelTokens: map[string]int64{"gpt-5": 180}, ModelCosts: map[string]string{"gpt-5": "2.5"}, AccountIDs: []string{"one", "two"}, CompletenessConfirmed: true},
		{ID: "b-1", SnapshotID: "b-s1", SourceID: "source-b", HubID: "hub-b", ObservedAt: start, TokenCount: 100, APICostUSDText: "1.25", ModelTokens: map[string]int64{}, ModelCosts: map[string]string{}},
		{ID: "b-2", SnapshotID: "b-s2", SourceID: "source-b", HubID: "hub-b", ObservedAt: start.Add(time.Hour), TokenCount: 180, APICostUSDText: "2.5", ModelTokens: map[string]int64{}, ModelCosts: map[string]string{}},
	}
	deltas, err := DeriveUsageDeltas(observations)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P2-USAGE-02 same source is counted once while distinct Hubs remain separate", func(t *testing.T) {
		if len(deltas) != 2 || deltas[0].SourceID != "source-a" || deltas[1].SourceID != "source-b" || deltas[0].Tokens != 80 || deltas[1].Tokens != 80 {
			t.Fatalf("usage deltas = %#v", deltas)
		}
	})
	t.Run("P2-USAGE-03 multi-account usage is marked shared instead of apportioned", func(t *testing.T) {
		if len(deltas) != 2 || !deltas[0].Shared || len(deltas[0].AccountIDs) != 2 || deltas[0].Tokens != 80 {
			t.Fatalf("shared attribution = %#v", deltas)
		}
	})
	t.Run("P2-USAGE-04 shared usage does not expose a false account contribution", func(t *testing.T) {
		if !deltas[0].Shared || deltas[0].APICostUSDText != "1.25" || len(deltas[0].AccountIDs) != 2 {
			t.Fatalf("shared contribution = %#v", deltas[0])
		}
	})
	t.Run("P2-USAGE-05 usage source remains included even without an account association", func(t *testing.T) {
		if !deltas[1].Shared || len(deltas[1].AccountIDs) != 0 || deltas[1].Tokens != 80 || deltas[1].APICostUSDText != "1.25" {
			t.Fatalf("unassigned usage = %#v", deltas[1])
		}
	})
	t.Run("AC-P2-05 each Hub source contributes one adjacent delta", func(t *testing.T) {
		if len(deltas) != 2 || deltas[0].Tokens+deltas[1].Tokens != 160 || deltas[0].APICostUSDText != "1.25" || deltas[1].APICostUSDText != "1.25" {
			t.Fatalf("deduplicated deltas = %#v", deltas)
		}
	})
	t.Run("AC-P2-06 shared activity is explicit and never apportioned", func(t *testing.T) {
		for _, delta := range deltas {
			if !delta.Shared || len(delta.AccountIDs) < 2 && delta.SourceID == "source-a" {
				t.Fatalf("shared activity = %#v", delta)
			}
		}
	})
}

func TestDeriveUsageDeltasDoesNotBridgeResetOrAttributionBoundary(t *testing.T) {
	t.Parallel()
	start := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	items := []UsageObservation{
		{ID: "one", SourceID: "source", ObservedAt: start, TokenCount: 100, APICostUSDText: "10", AccountIDs: []string{"a"}, PlanVersionIDs: []string{"plan-a"}, CompletenessConfirmed: true},
		{ID: "reset", SourceID: "source", ObservedAt: start.Add(time.Hour), TokenCount: 10, APICostUSDText: "1", AccountIDs: []string{"a"}, PlanVersionIDs: []string{"plan-a"}, CompletenessConfirmed: true},
		{ID: "changed", SourceID: "source", ObservedAt: start.Add(2 * time.Hour), TokenCount: 20, APICostUSDText: "2", AccountIDs: []string{"a", "b"}, PlanVersionIDs: []string{"plan-a"}, CompletenessConfirmed: true},
		{ID: "attributed", SourceID: "source", ObservedAt: start.Add(3 * time.Hour), TokenCount: 30, APICostUSDText: "3", AccountIDs: []string{"a"}, PlanVersionIDs: []string{"plan-a"}, CompletenessConfirmed: true},
		{ID: "plan-changed", SourceID: "source", ObservedAt: start.Add(4 * time.Hour), TokenCount: 40, APICostUSDText: "4", AccountIDs: []string{"a"}, PlanVersionIDs: []string{"plan-b"}, CompletenessConfirmed: true},
	}
	deltas, err := DeriveUsageDeltas(items)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P2-USAGE-07 reset, attribution, and plan boundaries are never bridged", func(t *testing.T) {
		if len(deltas) != 0 {
			t.Fatalf("reset/boundary was bridged: %#v", deltas)
		}
	})
}
