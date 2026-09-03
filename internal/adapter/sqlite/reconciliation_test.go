package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestAutomaticReconciliationBuildsDeterministicCodexConfiguration(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 5, 0, 0, 0, time.UTC)
	hubID, snapshotID := insertReconciliationObservationFixture(t, lifecycle, uuid.NewString(), "codex", "account-1", "Pro 5x", now)

	summary, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if summary.AccountsCreated != 1 || summary.PlanHistoriesCreated != 1 || summary.LimitAssociationsCreated != 1 || summary.CostAssociationsCreated != 1 || summary.CompletenessConfirmed != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	database, _ := lifecycle.DB()
	checks := map[string]int{
		`SELECT COUNT(*) FROM services`:                                                                         6,
		`SELECT COUNT(*) FROM service_identifier_mappings`:                                                      12,
		`SELECT COUNT(*) FROM logical_accounts`:                                                                 1,
		`SELECT COUNT(*) FROM hub_account_candidates WHERE state = 'associated'`:                                1,
		`SELECT COUNT(*) FROM plan_histories`:                                                                   1,
		`SELECT COUNT(*) FROM usage_limit_source_links`:                                                         1,
		`SELECT COUNT(*) FROM usage_cost_source_account_links`:                                                  1,
		`SELECT COUNT(*) FROM usage_cost_source_completeness WHERE state = 'confirmed'`:                         1,
		`SELECT COUNT(*) FROM observed_entitlements WHERE reported_plan_name = 'Pro 5x' AND state = 'resolved'`: 1,
		`SELECT COUNT(*) FROM normalization_runs WHERE snapshot_id = '` + snapshotID + `' AND state = 'active'`: 1,
	}
	for query, want := range checks {
		var got int
		if err := database.QueryRowContext(ctx, query).Scan(&got); err != nil {
			t.Fatalf("query %q: %v", query, err)
		}
		if got != want {
			t.Fatalf("query %q = %d, want %d", query, got, want)
		}
	}
	var auditsBefore int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits WHERE action = 'auto_reconcile'`).Scan(&auditsBefore); err != nil {
		t.Fatal(err)
	}
	repeated, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Changed() {
		t.Fatalf("repeated reconciliation changed configuration: %+v", repeated)
	}
	var auditsAfter int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits WHERE action = 'auto_reconcile'`).Scan(&auditsAfter); err != nil {
		t.Fatal(err)
	}
	if auditsAfter != auditsBefore {
		t.Fatalf("idempotent run added audit: before=%d after=%d", auditsBefore, auditsAfter)
	}
}

func TestAutomaticReconciliationDoesNotCreateLogicalAccountsForLegacyGrok(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 6, 0, 0, 0, time.UTC)
	for index, hubID := range []string{uuid.NewString(), uuid.NewString()} {
		insertReconciliationObservationFixture(t, lifecycle, hubID, "grok", "same-account-key", "", now.Add(time.Duration(index)*time.Minute))
		if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(time.Duration(index+2)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	database, _ := lifecycle.DB()
	var accounts, histories, links int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM logical_accounts la JOIN services s ON s.service_id = la.service_id WHERE s.official_key = 'grok'`).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM plan_histories`).Scan(&histories); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_limit_source_links`).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if accounts != 0 || histories != 0 || links != 0 {
		t.Fatalf("accounts=%d histories=%d links=%d", accounts, histories, links)
	}
	var candidates int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM hub_account_candidates WHERE state = 'unconfirmed' AND account_key_kind = 'legacy-credential-fingerprint'`).Scan(&candidates); err != nil {
		t.Fatal(err)
	}
	if candidates != 2 {
		t.Fatalf("legacy Grok candidates = %d, want 2", candidates)
	}
}

func TestAutomaticReconciliationLeavesStableGrokCandidateUnconfirmedDuringLegacyTransition(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 6, 30, 0, 0, time.UTC)
	hubID, snapshotID := insertReconciliationObservationFixture(t, lifecycle, uuid.NewString(), "grok", "legacy-token", "", now)
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	var serviceID string
	if err := database.QueryRowContext(ctx, `SELECT service_id FROM services WHERE official_key = 'grok'`).Scan(&serviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('legacy-logical', ?, 'Grok', ?, ?)`, serviceID, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE hub_account_candidates SET state = 'associated', logical_account_id = 'legacy-logical' WHERE hub_id = ? AND service_id = ? AND account_key = 'legacy-token'`, hubID, serviceID); err != nil {
		t.Fatal(err)
	}
	stableAt := now.Add(2 * time.Minute)
	stable := LimitObservation{ObservationID: "stable-grok-observation", UsageLimitSourceID: "stable-grok-source", HubAccountCandidateID: "stable-grok-candidate", IdentificationCandidateID: "stable-grok-identification", SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: "grok", AccountKey: "stable-subject", AccountKeyKind: "oidc-subject-v1", ProviderUpdatedAt: stableAt, WindowKey: "limit-id\x1fweekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", UsedPercent: float64Pointer(25), ResetsAt: timePointer(stableAt.Add(7 * 24 * time.Hour)), SyncUploadIntervalMS: int64Pointer(0), LimitsRefreshMS: int64Pointer(300000), AnalyticsIntervalSeconds: 300, NormalizationGeneration: 2, NormalizationRuleVersion: "api-stats-v1-device-updated-at", NormalizationLogicVersion: "t012-normalize-v2", JSONPath: "$.stable", DedupeKey: "stable-grok-dedupe", ValueFingerprint: "stable-grok-value"}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{stable}); err != nil {
		t.Fatal(err)
	}
	summary, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, stableAt.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if summary.AccountsCreated != 0 {
		t.Fatalf("summary = %+v", summary)
	}
	var accounts, unconfirmedStable int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM logical_accounts WHERE service_id = ?`, serviceID).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM hub_account_candidates WHERE hub_id = ? AND service_id = ? AND account_key = 'stable-subject' AND state = 'unconfirmed' AND logical_account_id IS NULL`, hubID, serviceID).Scan(&unconfirmedStable); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 || unconfirmedStable != 1 {
		t.Fatalf("logical accounts=%d unconfirmed stable candidates=%d", accounts, unconfirmedStable)
	}
}

func TestAutomaticReconciliationCreatesLogicalAccountForGrokOIDCSubject(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 7, 0, 0, 0, time.UTC)
	hubID, _ := insertReconciliationObservationFixture(t, lifecycle, uuid.NewString(), "grok", "oidc-account", "", now)
	database, _ := lifecycle.DB()
	if _, err := database.ExecContext(ctx, `UPDATE usage_limit_observations SET account_key_kind = 'oidc-subject-v1' WHERE hub_id = ?`, hubID); err != nil {
		t.Fatal(err)
	}
	summary, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if summary.AccountsCreated != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	var accounts int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM logical_accounts la JOIN services s ON s.service_id = la.service_id WHERE s.official_key = 'grok'`).Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 {
		t.Fatalf("Grok OIDC logical accounts = %d, want 1", accounts)
	}
}

func TestAutomaticReconciliationClosesPlanHistoryAtFirstNewPlanObservation(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 2, 9, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	insertReconciliationObservationFixture(t, lifecycle, hubID, "cursor", "account", "Pro", now)
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	changedAt := now.Add(24 * time.Hour)
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: "plan-change-attempt", HubID: hubID, Trigger: "manual", State: "started", StartedAt: changedAt, AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: "plan-change-snapshot", AttemptID: "plan-change-attempt", HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: changedAt, ReceivedCompletedAt: changedAt, HTTPStatus: 200, Body: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	limit := LimitObservation{ObservationID: "plan-change-limit", UsageLimitSourceID: "plan-change-source", HubAccountCandidateID: "plan-change-candidate", IdentificationCandidateID: "plan-change-identification", SnapshotID: "plan-change-snapshot", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cursor", AccountKey: "account", ProviderUpdatedAt: changedAt, WindowKey: "limit-id\x1fweekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", PlanLabel: "Pro+", UsedPercent: float64Pointer(30), ResetsAt: timePointer(changedAt.Add(7 * 24 * time.Hour)), SyncUploadIntervalMS: int64Pointer(0), LimitsRefreshMS: int64Pointer(300000), AnalyticsIntervalSeconds: 300, NormalizationGeneration: 2, NormalizationRuleVersion: "api-stats-v1-device-updated-at", NormalizationLogicVersion: "t012-normalize-v2", JSONPath: "$.limit", DedupeKey: "plan-change-key", ValueFingerprint: "plan-change-value"}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{limit}); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, changedAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	rows, err := database.QueryContext(ctx, `SELECT pv.name, ph.valid_from, COALESCE(ph.valid_to, '') FROM plan_histories ph JOIN plan_versions pv ON pv.plan_version_id = ph.plan_version_id ORDER BY ph.valid_from`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	type history struct{ name, from, to string }
	var histories []history
	for rows.Next() {
		var value history
		if err := rows.Scan(&value.name, &value.from, &value.to); err != nil {
			t.Fatal(err)
		}
		histories = append(histories, value)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(histories) != 2 || histories[0].name != "Pro" || histories[0].to != utcText(changedAt) || histories[1].name != "Pro+" || histories[1].from != utcText(changedAt) || histories[1].to != "" {
		t.Fatalf("histories = %#v", histories)
	}
}

func insertReconciliationObservationFixture(t *testing.T, lifecycle *Lifecycle, hubID, provider, accountKey, planLabel string, now time.Time) (string, string) {
	t.Helper()
	ctx := context.Background()
	if err := lifecycle.CreateHub(ctx, Hub{ID: hubID, DisplayName: hubID, URL: "https://" + hubID + ".example.test", CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.ReconcileObservedConfiguration(ctx, hubID, now); err != nil {
		t.Fatal(err)
	}
	attemptID, snapshotID := "attempt-"+hubID, "snapshot-"+hubID
	if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now, HTTPStatus: 200, APIContract: "schema=1;runtime=node-hub;core_revision=23;usage_observation_time=true", Body: []byte(`{"devices":[]}`)}); err != nil {
		t.Fatal(err)
	}
	cost := CostObservation{ObservationID: "cost-observation-" + hubID, UsageCostSourceID: "cost-source-" + hubID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: provider, UsageUpdatedAt: now, CostUSDText: "1", SyncUploadIntervalMS: int64Pointer(0), AnalyticsIntervalSeconds: 300, NormalizationGeneration: 2, NormalizationRuleVersion: "api-stats-v1-device-updated-at", NormalizationLogicVersion: "t012-normalize-v2", JSONPath: "$.cost", DedupeKey: "cost-" + hubID, ValueFingerprint: "cost-value"}
	accountKeyKind := ""
	if provider == "grok" {
		accountKeyKind = "legacy-credential-fingerprint"
	}
	limit := LimitObservation{ObservationID: "limit-observation-" + hubID, UsageLimitSourceID: "limit-source-" + hubID, HubAccountCandidateID: "candidate-" + hubID, IdentificationCandidateID: "identification-" + hubID, SnapshotID: snapshotID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: provider, AccountKey: accountKey, AccountKeyKind: accountKeyKind, ProviderUpdatedAt: now, WindowKey: "limit-id\x1fweekly", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", PlanLabel: planLabel, UsedPercent: float64Pointer(25), ResetsAt: timePointer(now.Add(7 * 24 * time.Hour)), SyncUploadIntervalMS: int64Pointer(0), LimitsRefreshMS: int64Pointer(300000), AnalyticsIntervalSeconds: 300, NormalizationGeneration: 2, NormalizationRuleVersion: "api-stats-v1-device-updated-at", NormalizationLogicVersion: "t012-normalize-v2", JSONPath: "$.limit", DedupeKey: "limit-" + hubID, ValueFingerprint: "limit-value"}
	if err := lifecycle.InsertObservations(ctx, []CostObservation{cost}, []LimitObservation{limit}); err != nil {
		t.Fatal(err)
	}
	return hubID, snapshotID
}

func int64Pointer(value int64) *int64        { return &value }
func float64Pointer(value float64) *float64  { return &value }
func timePointer(value time.Time) *time.Time { return &value }
