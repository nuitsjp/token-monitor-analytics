package desktop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

type overviewServiceReader struct {
	data       sqliteadapter.OverviewData
	events     map[string][]sqliteadapter.CredentialAuditEvent
	readDataAt time.Time
}

func (r *overviewServiceReader) ReadOverviewData(_ context.Context, now time.Time) (sqliteadapter.OverviewData, error) {
	r.readDataAt = now
	return r.data, nil
}

func (r *overviewServiceReader) ListCredentialAuditEvents(_ context.Context, hubID string) ([]sqliteadapter.CredentialAuditEvent, error) {
	return r.events[hubID], nil
}

func TestOverviewServiceSuppressesValuesDuringRestoreApply(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	reader := &overviewServiceReader{}
	service, err := NewOverviewServiceWithDependencies(reader, fixedClock{value: now}, domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	if err != nil {
		t.Fatal(err)
	}
	service.maintenance = windowMaintenanceFake{state: DataManagementMaintenanceSnapshot{Active: true, Operation: "restore", Phase: "restore_apply"}}
	snapshot, err := service.GetOverview(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Maintenance == nil || snapshot.Maintenance.Status.Label != "復元中" || len(snapshot.RecentLimits) != 0 {
		t.Fatalf("maintenance overview = %#v", snapshot)
	}
	if !reader.readDataAt.IsZero() {
		t.Fatal("overview reader was accessed while restore apply was active")
	}
}

func TestOverviewServiceComputesRemainingFreshnessAndUsesOneStatusMapper(t *testing.T) {
	t.Run("QL-UI-01 returns unrounded remainingPercent in the Go display DTO", func(t *testing.T) {
		now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
		reset := now.Add(time.Hour)
		reader := &overviewServiceReader{
			data: sqliteadapter.OverviewData{
				TimezoneConfirmed: true,
				Hubs:              []sqliteadapter.OverviewHub{{ID: "hub-1", DisplayName: "Hub 1", Enabled: true, CollectionEnabled: true, ConnectionState: "connected", CollectionRunning: true, LastCollectionState: "succeeded", LastSuccessAt: timePointer(now.Add(-time.Minute))}},
				ReviewActionCount: 2, ReviewWarningCount: 1,
				ReviewActionKindCounts: map[string]int{string(domain.ReviewKindIdentificationCandidate): 2}, ReviewWarningKindCounts: map[string]int{string(domain.ReviewKindMissingAccountKey): 1}, EstimationStatusCounts: map[string]int{"estimated": 1},
				ServiceCount: 1, LogicalAccountCount: 1, LimitAssociationCount: 1, CostAssociationCount: 1, ConfirmedCompletenessCount: 1,
				RecentLimits: []sqliteadapter.OverviewRecentLimit{{
					LogicalAccountID: "account-1", LimitDefinitionID: "definition-1", ServiceName: "Service",
					AccountName: "Account Secret", LimitName: "Weekly", CycleType: "weekly", UsedPercent: 25.5,
					ResetsAt: &reset, LastIncreaseAt: now.Add(-10 * time.Minute), LatestObservationAt: now.Add(-6 * time.Minute), ExpectedInterval: 5 * time.Minute,
				}},
			},
			events: map[string][]sqliteadapter.CredentialAuditEvent{"hub-1": {{Sequence: 1, Action: "credential_saved"}}},
		}
		service, err := NewOverviewServiceWithDependencies(reader, fixedClock{value: now}, domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
		if err != nil {
			t.Fatal(err)
		}
		snapshot, err := service.GetOverview(context.Background(), false)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.RecentLimits) != 1 {
			t.Fatalf("recent limits = %#v", snapshot.RecentLimits)
		}
		limit := snapshot.RecentLimits[0]
		if limit.RemainingPercent == nil || *limit.RemainingPercent != 74.5 || limit.RemainingLabel != "74.5%" || limit.RemainingDetailLabel != "74.50%" {
			t.Fatalf("remaining display = %#v", limit)
		}
		if limit.Remaining.Code != "remaining_high" {
			t.Fatalf("remaining status = %#v", limit.Remaining)
		}
		if limit.Freshness.Status.Code != "freshness_stale" || limit.Freshness.Reason == "" || limit.Freshness.ObservationAt != now.Add(-6*time.Minute).Format(time.RFC3339Nano) {
			t.Fatalf("freshness display = %#v", limit.Freshness)
		}
		if snapshot.Hubs.CredentialReadyCount != 1 || snapshot.Hubs.AbnormalCount != 0 || len(snapshot.Estimation.States) != 1 || snapshot.Estimation.States[0].Status.Label != "推定済み" {
			t.Fatalf("overview status DTO = %#v", snapshot)
		}
		if snapshot.Hubs.RunningCount != 1 || len(snapshot.Hubs.CurrentCollectionStates) != 1 || snapshot.Hubs.CurrentCollectionStates[0].Status.Code != "collection_started" || snapshot.Hubs.Items[0].LastCollection.Code != "collection_succeeded" {
			t.Fatalf("current and last collection state = %#v", snapshot.Hubs)
		}
		if len(snapshot.Review.ActionKinds) != 1 || snapshot.Review.ActionKinds[0].Label != "サービス・プラン同定候補" || len(snapshot.Review.WarningKinds) != 1 || snapshot.Review.WarningKinds[0].Count != 1 {
			t.Fatalf("review kind counts = %#v", snapshot.Review)
		}
		if len(snapshot.Checklist) != 7 || snapshot.Checklist[0].Status.Code != "complete" {
			t.Fatalf("checklist = %#v", snapshot.Checklist)
		}
		if !reader.readDataAt.Equal(now) {
			t.Fatalf("overview read time = %s, want %s", reader.readDataAt, now)
		}
	})
}

func TestOverviewChecklistRequiresCredentialReconfirmationAfterRestore(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	reader := &overviewServiceReader{
		data: sqliteadapter.OverviewData{
			Hubs:                    []sqliteadapter.OverviewHub{{ID: "hub-1", DisplayName: "Hub 1", ConnectionState: "not_checked"}},
			ReviewActionKindCounts:  map[string]int{},
			ReviewWarningKindCounts: map[string]int{},
			EstimationStatusCounts:  map[string]int{},
		},
		events: map[string][]sqliteadapter.CredentialAuditEvent{
			"hub-1": {
				{Sequence: 1, Action: "restore_succeeded"},
				{Sequence: 2, Action: "credential_saved"},
			},
		},
	}
	service, err := NewOverviewServiceWithDependencies(reader, fixedClock{value: now}, domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	if err != nil {
		t.Fatal(err)
	}
	pending, err := service.GetOverview(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Hubs.CredentialReadyCount != 0 || pending.Checklist[1].Status.Code == "complete" {
		t.Fatalf("credential was complete before reconfirmation: hubs=%#v checklist=%#v", pending.Hubs, pending.Checklist[1])
	}

	reader.events["hub-1"] = append(reader.events["hub-1"], sqliteadapter.CredentialAuditEvent{Sequence: 3, Action: "credential_reconfirmed"})
	registered, err := service.GetOverview(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if registered.Hubs.CredentialReadyCount != 1 || registered.Checklist[1].Status.Code != "complete" {
		t.Fatalf("credential was not complete after reconfirmation: hubs=%#v checklist=%#v", registered.Hubs, registered.Checklist[1])
	}
}

func TestOverviewServicePrivacyModeDoesNotSerializeUnmaskedSensitiveValues(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	reset := now.Add(7 * time.Hour)
	estimatedLimit := 123.0
	reader := &overviewServiceReader{data: sqliteadapter.OverviewData{
		ReviewActionKindCounts: map[string]int{}, ReviewWarningKindCounts: map[string]int{}, EstimationStatusCounts: map[string]int{},
		RecentLimits: []sqliteadapter.OverviewRecentLimit{{ServiceName: "Service", AccountName: "Account Secret", LimitName: "Daily", UsedPercent: 25.5, EstimatedLimit: &estimatedLimit, ResetsAt: &reset, LastIncreaseAt: now.Add(-time.Minute), LatestObservationAt: now.Add(-time.Minute), ExpectedInterval: 5 * time.Minute}},
	}, events: map[string][]sqliteadapter.CredentialAuditEvent{}}
	service, err := NewOverviewServiceWithDependencies(reader, fixedClock{value: now}, domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryNone})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.GetOverview(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, forbidden := range []string{"Account Secret", "74.5", "74.50", "$31.37", "$123.00", reset.Format(time.RFC3339Nano)} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("privacy DTO contains %q: %s", forbidden, text)
		}
	}
	limit := snapshot.RecentLimits[0]
	if !limit.PrivacyMasked || limit.AccountName != privacyMask || limit.RemainingPercent != nil || limit.RemainingLabel != privacyMask || limit.EstimatedUsageLabel != privacyMask || limit.EstimatedLimitLabel != privacyMask || !strings.Contains(limit.AccessibleLabel, privacyMask) || !strings.Contains(limit.Tooltip, privacyMask) {
		t.Fatalf("privacy DTO = %#v", limit)
	}
}

func TestOverviewRecentLimitMapsEstimatedUsageAndLimitLabels(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	estimatedLimit := 123.0
	mapped, err := mapOverviewRecentLimit(sqliteadapter.OverviewRecentLimit{
		ServiceName: "Service", AccountName: "Account", LimitName: "Weekly",
		UsedPercent: 25.5, EstimatedLimit: &estimatedLimit, LastIncreaseAt: now.Add(-time.Minute), LatestObservationAt: now.Add(-time.Minute), ExpectedInterval: 5 * time.Minute,
	}, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.EstimatedUsageLabel != "$31.36" || mapped.EstimatedLimitLabel != "$123.00" {
		t.Fatalf("estimated usage / limit = %q / %q", mapped.EstimatedUsageLabel, mapped.EstimatedLimitLabel)
	}
}

func TestOverviewServiceMapsStartupRestoreRecoveryNotice(t *testing.T) {
	reader := &overviewServiceReader{data: sqliteadapter.OverviewData{ReviewActionKindCounts: map[string]int{}, ReviewWarningKindCounts: map[string]int{}, EstimationStatusCounts: map[string]int{}}, events: map[string][]sqliteadapter.CredentialAuditEvent{}}
	service, err := NewOverviewServiceWithDependencies(reader, fixedClock{value: time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)}, domain.RestoreRecoveryResult{Status: domain.RestoreRecoveryRolledBack, ArtifactSHA256: strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.GetOverview(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.RecoveryNotice == nil || snapshot.RecoveryNotice.Status.Code != "recovery_rolled_back" || snapshot.RecoveryNotice.ArtifactSHA256 != strings.Repeat("a", 64) {
		t.Fatalf("recovery notice = %#v", snapshot.RecoveryNotice)
	}
}

func TestOverviewStatusMapperRejectsUnknownState(t *testing.T) {
	if _, err := statusPresentation("future_state"); err == nil {
		t.Fatal("unknown state was accepted")
	}
}

func TestOverviewStatusMapperIsTheCompleteSharedContract(t *testing.T) {
	t.Run("QL-UI-03 one mapper supplies label intent icon description and next action", func(t *testing.T) {
		for code, definition := range statusPresentations {
			got, err := statusPresentation(code)
			if err != nil {
				t.Fatalf("status %q was rejected: %v", code, err)
			}
			if got.Code != code || got.Label != definition.label || got.Intent != definition.intent || got.Icon != definition.icon || got.Description != definition.description || got.NextAction != definition.nextAction || got.NextRoute != definition.nextRoute {
				t.Fatalf("status %q mapping = %#v, definition = %#v", code, got, definition)
			}
			if got.Label == "" || got.Intent == "" || got.Icon == "" || got.Description == "" {
				t.Fatalf("status %q has incomplete display contract: %#v", code, got)
			}
		}
		if _, err := statusPresentation("future_state"); err == nil {
			t.Fatal("unknown status was accepted by the shared mapper")
		}
	})
}

func TestOverviewRemainingAndFreshnessBoundariesStayInGoDTO(t *testing.T) {
	t.Run("QL-UI-02 keeps freshness thresholds reasons and observation times in the Go DTO", func(t *testing.T) {
		now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
		tests := []struct {
			name     string
			used     float64
			observed time.Time
			status   string
			fresh    string
		}{
			{name: "above fifty", used: 49.9, observed: now.Add(-5 * time.Minute), status: "remaining_high", fresh: "freshness_current"},
			{name: "fifty", used: 50, observed: now.Add(-5 * time.Minute), status: "remaining_medium", fresh: "freshness_current"},
			{name: "twenty", used: 80, observed: now.Add(-5 * time.Minute), status: "remaining_medium", fresh: "freshness_current"},
			{name: "below twenty and stale", used: 80.1, observed: now.Add(-5*time.Minute - time.Nanosecond), status: "remaining_low", fresh: "freshness_stale"},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				mapped, err := mapOverviewRecentLimit(sqliteadapter.OverviewRecentLimit{
					ServiceName: "Service", AccountName: "Account", LimitName: "Limit",
					UsedPercent: test.used, LastIncreaseAt: now.Add(-time.Minute), LatestObservationAt: test.observed, ExpectedInterval: 5 * time.Minute,
				}, now, false)
				if err != nil {
					t.Fatal(err)
				}
				if mapped.Remaining.Code != test.status || mapped.Freshness.Status.Code != test.fresh {
					t.Fatalf("remaining/freshness = %q/%q, want %q/%q", mapped.Remaining.Code, mapped.Freshness.Status.Code, test.status, test.fresh)
				}
			})
		}
	})
}

func TestOverviewRecentLimitWithoutResetReachesUnknownResetDTO(t *testing.T) {
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	mapped, err := mapOverviewRecentLimit(sqliteadapter.OverviewRecentLimit{
		ServiceName: "Service", AccountName: "Account", LimitName: "Limit",
		UsedPercent: 25, LastIncreaseAt: now.Add(-time.Minute), LatestObservationAt: now.Add(-time.Minute), ExpectedInterval: 5 * time.Minute,
	}, now, false)
	if err != nil {
		t.Fatal(err)
	}
	if mapped.Reset.Code != "reset_unknown" || mapped.ResetAt != "" {
		t.Fatalf("reset DTO = %#v", mapped.Reset)
	}
}

func timePointer(value time.Time) *time.Time { return &value }
