package desktop

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

func newAccountTestService(t *testing.T) (*AccountService, *sqliteadapter.Lifecycle, time.Time) {
	t.Helper()
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "account.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	now := time.Date(2026, 8, 25, 12, 0, 0, 123456789, time.FixedZone("JST", 9*60*60))
	service, err := NewAccountServiceWithDependencies(lifecycle, fixedClock{value: now}, randomIDs{}, newDesktopTestMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	return service, lifecycle, now
}

func createAccountCatalogFixture(t *testing.T, lifecycle *sqliteadapter.Lifecycle, now time.Time) (string, string) {
	t.Helper()
	ctx := context.Background()
	catalog, err := NewCatalogServiceWithDependencies(lifecycle, fixedClock{value: now}, randomIDs{}, newDesktopTestMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	service, err := catalog.CreateService(ctx, CreateServiceInput{Provider: "Provider", Name: "Service", OfficialKey: "provider.service"})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHubServiceWithDependencies(lifecycle, &memoryCredentials{values: make(map[string]string)}, fixedClock{value: now}, randomIDs{}, newDesktopTestMaintenanceGate())
	hubSnapshot, err := hub.CreateHub(ctx, CreateHubInput{DisplayName: "Hub", URL: "https://hub.example", CollectionIntervalSeconds: 300, CollectionEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	versionStart := now.UTC().Add(-time.Hour)
	versionEnd := now.UTC().Add(3 * time.Hour)
	if err := catalog.CreatePlan(ctx, PlanInput{ID: "plan-1", ServiceID: service.ID, Name: "Plan"}); err != nil {
		t.Fatal(err)
	}
	if err := catalog.CreatePlanVersion(ctx, PlanVersionInput{ID: "plan-version-1", PlanID: "plan-1", Name: "v1", ValidFrom: versionStart.Format(time.RFC3339Nano), ValidTo: versionEnd.Format(time.RFC3339Nano), OfficialSourceURL: "https://provider.example/plan"}); err != nil {
		t.Fatal(err)
	}
	return service.ID, hubSnapshot.ID
}

func TestAccountServiceMapsDTOsAndUsesStrictRFC3339NanoPeriods(t *testing.T) {
	service, lifecycle, now := newAccountTestService(t)
	ctx := context.Background()
	serviceID, hubID := createAccountCatalogFixture(t, lifecycle, now)
	firstObserved := now.UTC().Add(-30 * time.Minute)
	lastObserved := now.UTC().Add(-10 * time.Minute)
	candidate := domain.HubAccountCandidate{
		ID: "candidate-1", HubID: hubID, ServiceID: serviceID, AccountKey: "account-key-1",
		DisplayName: "Observed account", Email: "person@example.test", WorkspaceName: "Workspace", DeviceName: "Device",
		FirstObservedAt: &firstObserved, LastObservedAt: &lastObserved, CreatedAt: now, UpdatedAt: now,
	}
	if err := lifecycle.CreateHubAccountCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}

	created, err := service.CreateLogicalAccountFromCandidate(ctx, CreateLogicalAccountFromCandidateInput{CandidateID: candidate.ID, ServiceID: serviceID, DisplayName: "Logical account"})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.ServiceID != serviceID || created.DisplayName != "Logical account" || created.CreatedAt != now.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("created account DTO = %+v", created)
	}
	encoded, err := json.Marshal(created)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "person@example.test") {
		t.Fatal("logical account DTO unexpectedly contains candidate evidence")
	}

	candidates, err := service.GetHubAccountCandidates(ctx, serviceID, string(domain.HubAccountCandidateAssociated))
	if err != nil || len(candidates) != 1 || candidates[0].LogicalAccountID != created.ID || candidates[0].AccountKey != candidate.AccountKey {
		t.Fatalf("candidate DTOs = %+v, err = %v", candidates, err)
	}
	if candidates[0].FirstObservedAt != firstObserved.Format(time.RFC3339Nano) {
		t.Fatalf("first observed timestamp = %q", candidates[0].FirstObservedAt)
	}

	if err := service.ReleaseHubAccountCandidate(ctx, candidate.ID); err != nil {
		t.Fatal(err)
	}
	released, err := service.GetHubAccountCandidates(ctx, serviceID, string(domain.HubAccountCandidateUnconfirmed))
	if err != nil || len(released) != 1 || released[0].LogicalAccountID != "" {
		t.Fatalf("released candidate DTOs = %+v, err = %v", released, err)
	}
	if err := service.RejectHubAccountCandidate(ctx, candidate.ID); err != nil {
		t.Fatal(err)
	}
	rejected, err := service.GetHubAccountCandidates(ctx, serviceID, string(domain.HubAccountCandidateRejected))
	if err != nil || len(rejected) != 1 || rejected[0].LogicalAccountID != "" {
		t.Fatalf("rejected candidate DTOs = %+v, err = %v", rejected, err)
	}
	if err := service.ReleaseHubAccountCandidate(ctx, candidate.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.AssociateHubAccountCandidate(ctx, candidate.ID, created.ID); err != nil {
		t.Fatal(err)
	}

	if err := service.UpdateLogicalAccount(ctx, UpdateLogicalAccountInput{ID: created.ID, ServiceID: serviceID, DisplayName: "Renamed account"}); err != nil {
		t.Fatal(err)
	}
	accounts, err := service.GetLogicalAccounts(ctx, serviceID, true)
	if err != nil || len(accounts) != 1 || accounts[0].DisplayName != "Renamed account" || accounts[0].CreatedAt != created.CreatedAt {
		t.Fatalf("updated accounts = %+v, err = %v", accounts, err)
	}
	if err := service.ArchiveLogicalAccount(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	accounts, err = service.GetLogicalAccounts(ctx, serviceID, true)
	if err != nil || len(accounts) != 1 || accounts[0].ArchivedAt == "" {
		t.Fatalf("archived accounts = %+v, err = %v", accounts, err)
	}
	if err := service.RestoreLogicalAccount(ctx, created.ID); err != nil {
		t.Fatal(err)
	}

	validFrom := now.UTC().Add(30 * time.Minute)
	validTo := now.UTC().Add(90 * time.Minute)
	history, err := service.CreatePlanHistory(ctx, CreatePlanHistoryInput{
		LogicalAccountID: created.ID, PlanVersionID: "plan-version-1",
		ValidFrom: validFrom.Format(time.RFC3339Nano), ValidTo: validTo.Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	if history.ValidFrom != validFrom.Format(time.RFC3339Nano) || history.ValidTo != validTo.Format(time.RFC3339Nano) {
		t.Fatalf("history DTO = %+v", history)
	}
	if err := service.UpdatePlanHistory(ctx, UpdatePlanHistoryInput{
		ID: history.ID, LogicalAccountID: created.ID, PlanVersionID: "plan-version-1",
		ValidFrom: validFrom.Format(time.RFC3339Nano), ValidTo: now.UTC().Add(2 * time.Hour).Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}
	histories, err := service.GetPlanHistories(ctx, created.ID)
	if err != nil || len(histories) != 1 || histories[0].ValidTo != now.UTC().Add(2*time.Hour).Format(time.RFC3339Nano) {
		t.Fatalf("updated histories = %+v, err = %v", histories, err)
	}
	if _, err := service.CreatePlanHistory(ctx, CreatePlanHistoryInput{LogicalAccountID: created.ID, PlanVersionID: "plan-version-1", ValidFrom: "2026/08/25 12:30:00"}); err == nil || !strings.Contains(err.Error(), "RFC3339Nano") {
		t.Fatalf("invalid period error = %v", err)
	}
}

func TestAccountServiceSplitsAndMergesThroughUsecase(t *testing.T) {
	service, lifecycle, now := newAccountTestService(t)
	ctx := context.Background()
	serviceID, hubID := createAccountCatalogFixture(t, lifecycle, now)
	source, err := service.CreateLogicalAccount(ctx, CreateLogicalAccountInput{ServiceID: serviceID, DisplayName: "Source"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := service.CreateLogicalAccount(ctx, CreateLogicalAccountInput{ServiceID: serviceID, DisplayName: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	candidate := domain.HubAccountCandidate{
		ID: "candidate-split", HubID: hubID, ServiceID: serviceID, AccountKey: "split-key",
		State: domain.HubAccountCandidateAssociated, LogicalAccountID: &source.ID, CreatedAt: now, UpdatedAt: now,
	}
	if err := lifecycle.CreateHubAccountCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	split, err := service.SplitLogicalAccount(ctx, SplitLogicalAccountInput{SourceID: source.ID, ServiceID: serviceID, DisplayName: "Split", CandidateIDs: []string{candidate.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if split.ID == "" || split.DisplayName != "Split" {
		t.Fatalf("split DTO = %+v", split)
	}
	if err := service.MergeLogicalAccounts(ctx, split.ID, target.ID); err != nil {
		t.Fatal(err)
	}
	accounts, err := service.GetLogicalAccounts(ctx, serviceID, true)
	if err != nil {
		t.Fatal(err)
	}
	var mergedSource LogicalAccountSnapshot
	for _, account := range accounts {
		if account.ID == split.ID {
			mergedSource = account
		}
	}
	if mergedSource.ArchivedAt == "" {
		t.Fatalf("merged source was not archived: %+v", accounts)
	}
	candidates, err := service.GetHubAccountCandidates(ctx, serviceID, string(domain.HubAccountCandidateAssociated))
	if err != nil || len(candidates) != 1 || candidates[0].LogicalAccountID != target.ID {
		t.Fatalf("merged candidate = %+v, err = %v", candidates, err)
	}
}

func TestNewAccountServiceRequiresDependencies(t *testing.T) {
	if _, err := NewAccountService(nil, newDesktopTestMaintenanceGate()); err == nil {
		t.Fatal("nil lifecycle was accepted")
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if _, err := NewAccountServiceWithDependencies(lifecycle, nil, randomIDs{}, newDesktopTestMaintenanceGate()); err == nil {
		t.Fatal("nil clock was accepted")
	}
	if _, err := NewAccountServiceWithDependencies(lifecycle, fixedClock{}, nil, newDesktopTestMaintenanceGate()); err == nil {
		t.Fatal("nil ID generator was accepted")
	}
}

func TestAccountServiceExposesT023LinkingWithStrictPeriods(t *testing.T) {
	service, lifecycle, now := newAccountTestService(t)
	ctx := context.Background()
	serviceID, hubID := createAccountCatalogFixture(t, lifecycle, now)
	account, err := service.CreateLogicalAccount(ctx, CreateLogicalAccountInput{ServiceID: serviceID, DisplayName: "Linked account"})
	if err != nil {
		t.Fatal(err)
	}
	costSource := domain.UsageCostSource{
		ID: "cost-source-1", HubID: hubID, DeviceID: "device-1",
		RawServiceIdentifier: "provider.cost", CreatedAt: now,
	}
	if err := lifecycle.CreateUsageCostSource(ctx, costSource); err != nil {
		t.Fatal(err)
	}
	limitSource := domain.UsageLimitSource{
		ID: "limit-source-1", HubID: hubID, DeviceID: "device-1", AccountKey: "account-key",
		RawServiceIdentifier: "provider.limit", WindowKey: "weekly-percent",
		NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Weekly", CreatedAt: now,
	}
	if err := lifecycle.CreateUsageLimitSource(ctx, limitSource); err != nil {
		t.Fatal(err)
	}
	catalogService, err := NewCatalogServiceWithDependencies(lifecycle, fixedClock{value: now}, randomIDs{}, newDesktopTestMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	if err := catalogService.CreateLimitDefinition(ctx, LimitDefinitionInput{ID: "limit-definition-1", ServiceID: serviceID, CycleType: "weekly", Meaning: "Weekly limit", Unit: "%"}); err != nil {
		t.Fatal(err)
	}
	from := now.UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	to := now.UTC().Add(time.Hour).Format(time.RFC3339Nano)
	cost, err := service.CreateUsageCostAssociation(ctx, UsageCostAssociationInput{
		UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: from, ValidTo: to,
	})
	if err != nil || cost.ID == "" {
		t.Fatalf("cost association = %+v, err = %v", cost, err)
	}
	preview, err := service.PreviewUsageCostAssociation(ctx, UsageCostAssociationInput{
		UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: from, ValidTo: to,
	})
	if err != nil || preview.SourceID != costSource.ID || preview.IntervalStart != from || preview.IntervalEnd != to {
		t.Fatalf("cost preview = %+v, err = %v", preview, err)
	}
	if _, err := service.PreviewUsageCostAssociation(ctx, UsageCostAssociationInput{
		UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: "2026/08/25 12:00:00",
	}); err == nil || !strings.Contains(err.Error(), "RFC3339Nano") {
		t.Fatalf("invalid cost preview error = %v", err)
	}
	if err := service.UpdateUsageCostAssociation(ctx, UsageCostAssociationInput{
		ID: cost.ID, UsageCostSourceID: costSource.ID, LogicalAccountID: account.ID, ValidFrom: from, ValidTo: "",
	}); err != nil {
		t.Fatal(err)
	}
	limit, err := service.CreateUsageLimitAssociation(ctx, UsageLimitAssociationInput{
		UsageLimitSourceID: limitSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: "limit-definition-1", ValidFrom: from, ValidTo: to,
	})
	if err != nil || limit.ID == "" {
		t.Fatalf("limit association = %+v, err = %v", limit, err)
	}
	if _, err := service.PreviewUsageLimitAssociation(ctx, UsageLimitAssociationInput{
		UsageLimitSourceID: limitSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: "limit-definition-1", ValidFrom: from, ValidTo: to,
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.UpdateUsageLimitAssociation(ctx, UsageLimitAssociationInput{
		ID: limit.ID, UsageLimitSourceID: limitSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: "limit-definition-1", ValidFrom: from, ValidTo: "",
	}); err != nil {
		t.Fatal(err)
	}
	completenessPreview, err := service.PreviewUsageCostSourceCompleteness(ctx, UsageCostSourceCompletenessInput{
		UsageCostSourceID: costSource.ID, ValidFrom: from, ValidTo: to, State: string(domain.CompletenessConfirmed), LogicalAccountIDs: []string{account.ID}, ExcludedActivity: []string{},
	})
	if err != nil || completenessPreview.SourceID != costSource.ID || completenessPreview.SourceKind != "usage_cost_completeness" || completenessPreview.IntervalStart != from || completenessPreview.IntervalEnd != to {
		t.Fatalf("completeness preview = %+v, err = %v", completenessPreview, err)
	}
	completeness, err := service.ConfirmUsageCostSourceCompleteness(ctx, UsageCostSourceCompletenessInput{
		UsageCostSourceID: costSource.ID, ValidFrom: from, ValidTo: to, State: string(domain.CompletenessConfirmed), LogicalAccountIDs: []string{account.ID}, ExcludedActivity: []string{},
	})
	if err != nil || completeness.State != string(domain.CompletenessConfirmed) {
		t.Fatalf("completeness = %+v, err = %v", completeness, err)
	}
	if err := service.UpdateUsageCostSourceCompleteness(ctx, UsageCostSourceCompletenessInput{
		ID: completeness.ID, UsageCostSourceID: costSource.ID, ValidFrom: from, ValidTo: "", State: string(domain.CompletenessConfirmed), LogicalAccountIDs: []string{account.ID}, ExcludedActivity: []string{},
	}); err != nil {
		t.Fatal(err)
	}
	hubService := NewHubServiceWithDependencies(lifecycle, &memoryCredentials{values: make(map[string]string)}, fixedClock{value: now}, randomIDs{}, newDesktopTestMaintenanceGate())
	newHub, err := hubService.CreateHub(ctx, CreateHubInput{DisplayName: "New Hub", URL: "https://new-hub.example", CollectionIntervalSeconds: 300, CollectionEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	switchPreview, err := service.PreviewHubSwitch(ctx, HubSwitchInput{
		OldHubID: hubID, OldDeviceID: "device-1", NewHubID: newHub.ID, NewDeviceID: "device-2", CollectionDeviceID: "collector-1", SwitchedAt: now.UTC().Format(time.RFC3339Nano),
	})
	if err != nil || switchPreview.SourceKind != "hub_switch" || switchPreview.IntervalStart != now.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("Hub switch preview = %+v, err = %v", switchPreview, err)
	}
	switchSnapshot, err := service.ConfirmHubSwitch(ctx, HubSwitchInput{
		OldHubID: hubID, OldDeviceID: "device-1", NewHubID: newHub.ID, NewDeviceID: "device-2", CollectionDeviceID: "collector-1", SwitchedAt: now.UTC().Format(time.RFC3339Nano),
	})
	if err != nil || switchSnapshot.ID == "" || switchSnapshot.SwitchedAt != now.UTC().Format(time.RFC3339Nano) {
		t.Fatalf("Hub switch = %+v, err = %v", switchSnapshot, err)
	}
	linking, err := service.GetLinkingSnapshot(ctx)
	if err != nil || len(linking.UsageCostSources) != 1 || len(linking.UsageLimitSources) != 1 || len(linking.UsageCostAssociations) != 1 || len(linking.UsageLimitAssociations) != 1 || len(linking.UsageCostSourceCompleteness) != 1 || len(linking.HubSwitches) != 1 {
		t.Fatalf("linking snapshot = %+v, err = %v", linking, err)
	}
}
