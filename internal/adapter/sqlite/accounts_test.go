package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

func TestAccountsKeepCrossHubSameKeyAsCandidatesAndFlagArchivedReconfirmation(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "account-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	hubA := insertAccountTestHub(t, lifecycle, now, "hub-a")
	hubB := insertAccountTestHub(t, lifecycle, now, "hub-b")
	baseCandidate := func(id, hubID string) HubAccountCandidate {
		return HubAccountCandidate{ID: id, HubID: hubID, ServiceID: service.ID, AccountKey: "same-key", DisplayName: "Display", Email: "person@example.test", CreatedAt: now, UpdatedAt: now}
	}
	if err := lifecycle.CreateHubAccountCandidate(ctx, baseCandidate("candidate-a", hubA)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateHubAccountCandidate(ctx, baseCandidate("candidate-b", hubB)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateHubAccountCandidate(ctx, HubAccountCandidate{ID: "empty-key", HubID: hubA, ServiceID: service.ID, DisplayName: "Only display", CreatedAt: now, UpdatedAt: now}); !errors.Is(err, ErrHubAccountCandidateRequiresKey) {
		t.Fatalf("empty account key error = %v", err)
	}
	candidates, err := lifecycle.ListHubAccountCandidates(ctx, service.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("cross-Hub candidates = %d, want 2", len(candidates))
	}

	account := LogicalAccount{ID: "logical-a", ServiceID: service.ID, DisplayName: "Logical", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccountFromHubAccountCandidate(ctx, "candidate-a", account); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ArchiveLogicalAccount(ctx, account.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.UpsertHubAccountCandidate(ctx, baseCandidate("new-id-is-not-an-identity", hubA)); err != nil {
		t.Fatal(err)
	}
	candidates, err = lifecycle.ListHubAccountCandidates(ctx, service.ID, domain.HubAccountCandidateArchivedReconfirmation)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 || candidates[0].ID != "candidate-a" {
		t.Fatalf("archived reconfirmation candidates = %#v", candidates)
	}

	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var audits, requests int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits WHERE entity_type IN ('catalog_hub_account_candidate', 'catalog_logical_account')`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if audits == 0 || requests < audits {
		t.Fatalf("account audits=%d requests=%d", audits, requests)
	}
}

func TestPlanHistoryRejectsOverlapReverseAndPlanVersionOutsidePeriod(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "history-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	plan := Plan{ID: "history-plan", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	versionStart := now.Add(time.Hour)
	versionEnd := now.Add(3 * time.Hour)
	version := PlanVersion{ID: "history-version", PlanID: plan.ID, Name: "v1", ValidFrom: versionStart, ValidTo: &versionEnd, OfficialSourceURL: "https://vendor.example/plan", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	account := LogicalAccount{ID: "history-account", ServiceID: service.ID, DisplayName: "Account", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	firstEnd := now.Add(2 * time.Hour)
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-1", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: versionStart, ValidTo: &firstEnd, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// Adjacent half-open history is valid.
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-2", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: firstEnd, ValidTo: &versionEnd, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("adjacent history rejected: %v", err)
	}
	overlapEnd := versionEnd
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-overlap", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: firstEnd.Add(-time.Minute), ValidTo: &overlapEnd, CreatedAt: now, UpdatedAt: now}); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("overlap history error = %v", err)
	}
	reverse := versionStart.Add(-time.Minute)
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-reverse", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: versionStart, ValidTo: &reverse, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatal("reverse history was accepted")
	}
	outside := versionStart.Add(-time.Minute)
	outsideEnd := versionStart.Add(30 * time.Minute)
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-outside", LogicalAccountID: account.ID, PlanVersionID: version.ID, ValidFrom: outside, ValidTo: &outsideEnd, CreatedAt: now, UpdatedAt: now}); err == nil || !strings.Contains(err.Error(), "outside") {
		t.Fatalf("outside history error = %v", err)
	}
	otherService := testCatalogService(now, "history-other-service")
	otherService.OfficialKey = "official.history-other-service"
	if err := lifecycle.CreateService(ctx, otherService); err != nil {
		t.Fatal(err)
	}
	otherPlan := Plan{ID: "history-other-plan", ServiceID: otherService.ID, Name: "Other", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, otherPlan); err != nil {
		t.Fatal(err)
	}
	otherVersion := PlanVersion{ID: "history-other-version", PlanID: otherPlan.ID, Name: "v1", ValidFrom: versionStart, ValidTo: &versionEnd, OfficialSourceURL: "https://vendor.example/other", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, otherVersion); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreatePlanHistory(ctx, PlanHistory{ID: "history-service-mismatch", LogicalAccountID: account.ID, PlanVersionID: otherVersion.ID, ValidFrom: versionStart, ValidTo: &versionEnd, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatalf("service mismatch history error = %v", err)
	}
}

func TestLogicalAccountSplitAndMergePreserveAuditAndArchiveSource(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "split-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	hubID := insertAccountTestHub(t, lifecycle, now, "split-hub")
	source := LogicalAccount{ID: "split-source", ServiceID: service.ID, DisplayName: "Source", CreatedAt: now, UpdatedAt: now}
	target := LogicalAccount{ID: "split-target", ServiceID: service.ID, DisplayName: "Target", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccount(ctx, source); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateLogicalAccount(ctx, target); err != nil {
		t.Fatal(err)
	}
	for index, id := range []string{"candidate-1", "candidate-2"} {
		if err := lifecycle.CreateHubAccountCandidate(ctx, HubAccountCandidate{ID: id, HubID: hubID, ServiceID: service.ID, AccountKey: id, State: domain.HubAccountCandidateAssociated, LogicalAccountID: stringPtr(source.ID), CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		_ = index
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var auditsBefore, requestsBefore int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits`).Scan(&auditsBefore); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests`).Scan(&requestsBefore); err != nil {
		t.Fatal(err)
	}
	badAccount := LogicalAccount{ID: "split-rollback", ServiceID: service.ID, DisplayName: "Should rollback", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.SplitLogicalAccount(ctx, source.ID, badAccount, "missing-candidate"); err == nil {
		t.Fatal("split with a missing candidate was accepted")
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM logical_accounts WHERE logical_account_id = ?`, badAccount.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled-back split account count = %d", count)
	}
	var auditsAfter, requestsAfter int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits`).Scan(&auditsAfter); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests`).Scan(&requestsAfter); err != nil {
		t.Fatal(err)
	}
	if auditsAfter != auditsBefore || requestsAfter != requestsBefore {
		t.Fatalf("failed split changed audit/recalc counts: before=%d/%d after=%d/%d", auditsBefore, requestsBefore, auditsAfter, requestsAfter)
	}
	newAccount := LogicalAccount{ID: "split-new", ServiceID: service.ID, DisplayName: "New", CreatedAt: now, UpdatedAt: now.Add(time.Minute)}
	if err := lifecycle.SplitLogicalAccount(ctx, source.ID, newAccount, "candidate-1"); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.MergeLogicalAccounts(ctx, newAccount.ID, target.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var owner string
	if err := database.QueryRow(`SELECT logical_account_id FROM hub_account_candidates WHERE hub_account_candidate_id = 'candidate-1'`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != target.ID {
		t.Fatalf("merged candidate owner = %q, want %q", owner, target.ID)
	}
	var archived sqlNullString
	if err := database.QueryRow(`SELECT archived_at FROM logical_accounts WHERE logical_account_id = ?`, newAccount.ID).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if !archived.Valid {
		t.Fatal("merged source was not archived")
	}
}

type sqlNullString struct {
	String string
	Valid  bool
}

func (s *sqlNullString) Scan(value any) error {
	if value == nil {
		s.Valid = false
		return nil
	}
	s.String, s.Valid = value.(string)
	return nil
}

func insertAccountTestHub(t *testing.T, lifecycle *Lifecycle, now time.Time, id string) string {
	t.Helper()
	hubID := uuid.NewString()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES (?, ?, ?, 1, 300, ?, ?)`, hubID, id, "https://"+id+".example", utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hub_connection_statuses (hub_id, state) VALUES (?, 'not_checked')`, hubID); err != nil {
		t.Fatal(err)
	}
	return hubID
}
