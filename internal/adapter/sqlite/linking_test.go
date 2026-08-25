package sqlite

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestT023SourceAssociationsSupportCostNNLimitSingleAndImpactPreview(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := insertAccountTestHub(t, lifecycle, now, "linking-hub")
	service := testCatalogService(now, "linking-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	accountA := LogicalAccount{ID: "logical-a", ServiceID: service.ID, DisplayName: "A", CreatedAt: now, UpdatedAt: now}
	accountB := LogicalAccount{ID: "logical-b", ServiceID: service.ID, DisplayName: "B", CreatedAt: now, UpdatedAt: now}
	for _, account := range []LogicalAccount{accountA, accountB} {
		if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
			t.Fatal(err)
		}
	}
	definition := LimitDefinition{ID: "definition", ServiceID: service.ID, CycleType: "weekly", Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}

	costSource := UsageCostSource{ID: "cost-source", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cost.raw", CreatedAt: now}
	if err := lifecycle.CreateUsageCostSource(ctx, costSource); err != nil {
		t.Fatal(err)
	}
	from, boundary := now, now.Add(2*time.Hour)
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "cost-a", UsageCostSourceID: costSource.ID, LogicalAccountID: accountA.ID, ValidFrom: from, ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// A cost source can be related to more than one logical account in the
	// same period; this is shared observed usage, not an allocation.
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "cost-b", UsageCostSourceID: costSource.ID, LogicalAccountID: accountB.ID, ValidFrom: from, ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "cost-a-overlap", UsageCostSourceID: costSource.ID, LogicalAccountID: accountA.ID, ValidFrom: now.Add(time.Hour), ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatal("overlapping cost association was accepted")
	}

	limitSource := UsageLimitSource{ID: "limit-source", HubID: hubID, DeviceID: "device", AccountKey: "account", RawServiceIdentifier: "limit.raw", WindowKey: "window-v1", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Tokens", CreatedAt: now}
	if err := lifecycle.CreateUsageLimitSource(ctx, limitSource); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "limit-a", UsageLimitSourceID: limitSource.ID, LogicalAccountID: accountA.ID, LimitDefinitionID: definition.ID, ValidFrom: from, ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "limit-overlap", UsageLimitSourceID: limitSource.ID, LogicalAccountID: accountB.ID, LimitDefinitionID: definition.ID, ValidFrom: now.Add(time.Hour), ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err == nil {
		t.Fatal("overlapping limit association was accepted")
	}
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "limit-adjacent", UsageLimitSourceID: limitSource.ID, LogicalAccountID: accountB.ID, LimitDefinitionID: definition.ID, ValidFrom: boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatalf("adjacent limit association was rejected: %v", err)
	}

	attempt := CollectionAttempt{AttemptID: "attempt-linking", HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}
	if err := lifecycle.CreateCollectionAttempt(ctx, attempt); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: "snapshot-linking", AttemptID: attempt.AttemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now.Add(time.Second), HTTPStatus: 200, Body: []byte(`{"devices":[]}`)}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.InsertCostObservations(ctx, []CostObservation{{ObservationID: "cost-observation", SnapshotID: "snapshot-linking", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cost.raw", UsageUpdatedAt: now.Add(time.Minute), CostUSDText: "1", AnalyticsIntervalSeconds: 300, JSONPath: "$.devices[0]", DedupeKey: "cost-key", ValueFingerprint: "cost-value"}}); err != nil {
		t.Fatal(err)
	}
	preview, err := lifecycle.PreviewUsageCostAssociation(ctx, UsageCostAssociation{UsageCostSourceID: costSource.ID, LogicalAccountID: accountA.ID, ValidFrom: from, ValidTo: &boundary, CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.AffectedObservationIDs) != 1 || preview.AffectedObservationIDs[0] != "cost-observation" {
		t.Fatalf("impact preview observations = %#v", preview.AffectedObservationIDs)
	}
	associations, err := lifecycle.ListUsageCostAssociations(ctx, costSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(associations) != 2 {
		t.Fatalf("preview changed associations: %#v", associations)
	}
	updatedEnd := boundary.Add(time.Hour)
	updated := UsageCostAssociation{ID: "cost-a", UsageCostSourceID: costSource.ID, LogicalAccountID: accountA.ID, ValidFrom: from, ValidTo: &updatedEnd, CreatedAt: now, UpdatedAt: now.Add(time.Minute)}
	updatePreview, err := lifecycle.PreviewUsageCostAssociation(ctx, updated)
	if err != nil {
		t.Fatal(err)
	}
	if len(updatePreview.AffectedObservationIDs) != 1 || len(associations) != 2 {
		t.Fatalf("update preview changed persisted associations: preview=%#v associations=%#v", updatePreview, associations)
	}
	if err := lifecycle.UpdateUsageCostAssociation(ctx, updated); err != nil {
		t.Fatal(err)
	}
	associations, err = lifecycle.ListUsageCostAssociations(ctx, costSource.ID)
	if err != nil {
		t.Fatal(err)
	}
	var updatedAssociation *UsageCostAssociation
	for index := range associations {
		if associations[index].ID == updated.ID {
			updatedAssociation = &associations[index]
		}
	}
	if updatedAssociation == nil || updatedAssociation.ValidTo == nil || !updatedAssociation.ValidTo.Equal(updatedEnd) {
		t.Fatalf("updated cost association = %#v", associations)
	}
}

func TestT023CompletenessRejectsMixedUnconfirmedActivityForWholeInterval(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := insertAccountTestHub(t, lifecycle, now, "completeness-hub")
	service := testCatalogService(now, "completeness-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	account := LogicalAccount{ID: "complete-account", ServiceID: service.ID, DisplayName: "Complete", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	source := UsageCostSource{ID: "complete-source", HubID: hubID, DeviceID: "device", RawServiceIdentifier: "cost.raw", CreatedAt: now}
	if err := lifecycle.CreateUsageCostSource(ctx, source); err != nil {
		t.Fatal(err)
	}
	end := now.Add(2 * time.Hour)
	if err := lifecycle.CreateUsageCostAssociation(ctx, UsageCostAssociation{ID: "complete-link", UsageCostSourceID: source.ID, LogicalAccountID: account.ID, ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	middle := now.Add(time.Hour)
	if err := lifecycle.CreateUsageCostSourceCompleteness(ctx, UsageCostSourceCompleteness{ID: "complete-before", UsageCostSourceID: source.ID, ValidFrom: now, ValidTo: &middle, State: CompletenessConfirmed, LogicalAccountIDs: []string{account.ID}, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageCostSourceCompleteness(ctx, UsageCostSourceCompleteness{ID: "complete-after", UsageCostSourceID: source.ID, ValidFrom: middle, ValidTo: &end, State: CompletenessUnconfirmed, LogicalAccountIDs: []string{account.ID}, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	usable, err := lifecycle.CanUseUsageCostSourceForEstimation(ctx, source.ID, now, end)
	if err != nil {
		t.Fatal(err)
	}
	if usable {
		t.Fatal("mixed completeness interval was estimable")
	}
	usable, err = lifecycle.CanUseUsageCostSourceForEstimation(ctx, source.ID, now, middle)
	if err != nil {
		t.Fatal(err)
	}
	if !usable {
		t.Fatal("confirmed completeness interval was not estimable")
	}
	if err := lifecycle.UpdateUsageCostSourceCompleteness(ctx, UsageCostSourceCompleteness{ID: "complete-after", UsageCostSourceID: source.ID, ValidFrom: middle, ValidTo: &end, State: CompletenessConfirmed, LogicalAccountIDs: []string{account.ID}, CreatedAt: now, UpdatedAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	usable, err = lifecycle.CanUseUsageCostSourceForEstimation(ctx, source.ID, now, end)
	if err != nil || !usable {
		t.Fatalf("confirmed complete interval usable=%v err=%v", usable, err)
	}
}

func TestT023RenameArchiveReconfirmationAndHubSwitchRequireExplicitConfirmation(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubA := insertAccountTestHub(t, lifecycle, now, "rename-hub-a")
	hubB := insertAccountTestHub(t, lifecycle, now, "rename-hub-b")
	service := testCatalogService(now, "rename-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	account := LogicalAccount{ID: "rename-account", ServiceID: service.ID, DisplayName: "Account", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLogicalAccount(ctx, account); err != nil {
		t.Fatal(err)
	}
	definition := LimitDefinition{ID: "rename-definition", ServiceID: service.ID, CycleType: "weekly", Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	oldLabel := "Old label"
	if err := lifecycle.CreateLimitLabelChangeCandidate(ctx, LimitLabelChangeCandidate{ID: "rename-candidate", HubID: hubA, DeviceRecordKey: "device", RawLimitServiceIdentifier: "limit.raw", NormalizedKind: "weekly", NormalizedMetric: "percent", OldLabel: oldLabel, NewLabel: "New label", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.DecideLimitLabelChangeCandidate(ctx, "rename-candidate", domain.LabelChangeSameLimit, definition.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	oldSource := UsageLimitSource{ID: "rename-old-source", HubID: hubA, DeviceID: "device", AccountKey: "account", RawServiceIdentifier: "limit.raw", WindowKey: "window-old", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "Old label", CreatedAt: now}
	newSource := UsageLimitSource{ID: "rename-new-source", HubID: hubA, DeviceID: "device", AccountKey: "account", RawServiceIdentifier: "limit.raw", WindowKey: "window-new", NormalizedKind: "weekly", NormalizedMetric: "percent", NormalizedLabel: "New label", CreatedAt: now}
	if err := lifecycle.CreateUsageLimitSource(ctx, oldSource); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageLimitSource(ctx, newSource); err != nil {
		t.Fatal(err)
	}
	boundary := now.Add(time.Hour)
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "rename-old-link", UsageLimitSourceID: oldSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: definition.ID, ValidFrom: now, ValidTo: &boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateUsageLimitAssociation(ctx, UsageLimitAssociation{ID: "rename-new-link", UsageLimitSourceID: newSource.ID, LogicalAccountID: account.ID, LimitDefinitionID: definition.ID, ValidFrom: boundary, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListLimitLabelChangeCandidates(ctx, domain.LabelChangeSameLimit)
	if err != nil || len(rows) != 1 || rows[0].LimitDefinitionID == nil || *rows[0].LimitDefinitionID != definition.ID {
		t.Fatalf("rename decision rows=%#v err=%v", rows, err)
	}

	candidate := HubAccountCandidate{ID: "archive-candidate", HubID: hubA, ServiceID: service.ID, AccountKey: "account-key", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateHubAccountCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateLogicalAccountFromHubAccountCandidate(ctx, candidate.ID, LogicalAccount{ID: "archive-candidate", ServiceID: service.ID, DisplayName: "Archived", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ArchiveLogicalAccount(ctx, "archive-candidate", now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.UpsertHubAccountCandidate(ctx, HubAccountCandidate{ID: "new-id", HubID: hubA, ServiceID: service.ID, AccountKey: candidate.AccountKey, CreatedAt: now, UpdatedAt: now.Add(3 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	archivedCandidates, err := lifecycle.ListHubAccountCandidates(ctx, service.ID, domain.HubAccountCandidateArchivedReconfirmation)
	if err != nil || len(archivedCandidates) != 1 || archivedCandidates[0].ID != candidate.ID {
		t.Fatalf("archived reconfirmation candidates=%#v err=%v", archivedCandidates, err)
	}
	if err := lifecycle.ConfirmHubSwitch(ctx, HubSwitch{ID: "hub-switch", OldHubID: hubA, OldDeviceID: "device", NewHubID: hubB, NewDeviceID: "device-new", CollectionDeviceID: "collector", SwitchedAt: boundary, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	switches, err := lifecycle.ListHubSwitches(ctx)
	if err != nil || len(switches) != 1 || switches[0].OldHubID != hubA || switches[0].NewHubID != hubB {
		t.Fatalf("Hub switches=%#v err=%v", switches, err)
	}
	if err := lifecycle.ConfirmHubSwitch(ctx, HubSwitch{ID: "invalid-switch", OldHubID: hubA, OldDeviceID: "device", NewHubID: hubA, NewDeviceID: "device", CollectionDeviceID: "collector", SwitchedAt: boundary, CreatedAt: now}); err == nil {
		t.Fatal("unchanged Hub switch was accepted")
	}
}

func TestT023CollectionObservationCreatesCandidatesInOneTransaction(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubA := insertAccountTestHub(t, lifecycle, now, "collection-candidate-hub-a")
	hubB := insertAccountTestHub(t, lifecycle, now, "collection-candidate-hub-b")
	service := testCatalogService(now, "collection-candidate-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMapping{
		ID: "collection-candidate-mapping", Kind: domain.UsageLimitIdentifier, RawIdentifier: "limit.raw",
		ServiceID: service.ID, ValidFrom: now.Add(-time.Hour), CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	for _, hubID := range []string{hubA, hubB} {
		attemptID, snapshotID := "candidate-attempt-"+hubID, "candidate-snapshot-"+hubID
		if err := lifecycle.CreateCollectionAttempt(ctx, CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: now, AnalyticsIntervalSeconds: 300}); err != nil {
			t.Fatal(err)
		}
		if err := lifecycle.SaveRawSnapshot(ctx, RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: now, ReceivedCompletedAt: now.Add(time.Second), HTTPStatus: 200, Body: []byte(`{}`)}); err != nil {
			t.Fatal(err)
		}
	}
	makeObservation := func(hubID, suffix, accountKey, rawPlan, label string, at time.Time) LimitObservation {
		return LimitObservation{
			ObservationID: "candidate-observation-" + suffix, UsageLimitSourceID: "candidate-source-" + suffix,
			HubAccountCandidateID: "candidate-account-" + suffix, IdentificationCandidateID: "candidate-identification-" + suffix,
			SnapshotID: "candidate-snapshot-" + hubID, HubID: hubID, DeviceID: "device", RawServiceIdentifier: "limit.raw",
			AccountKey: accountKey, ProviderUpdatedAt: at, WindowKey: "window-v1", NormalizedKind: "weekly", NormalizedMetric: "percent",
			NormalizedLabel: label, PlanLabel: rawPlan, AnalyticsIntervalSeconds: 300, JSONPath: "$.limits[0]",
			DedupeKey: "candidate-dedupe-" + suffix, ValueFingerprint: "candidate-fingerprint-" + suffix,
		}
	}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{makeObservation(hubA, "old", "account-key", "Plan A", "Old label", now)}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{makeObservation(hubA, "new", "account-key", "Plan A", "New label", now.Add(time.Hour))}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{makeObservation(hubA, "continued", "account-key", "Plan A", "New label", now.Add(2*time.Hour))}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{makeObservation(hubB, "other-hub", "account-key", "Plan A", "Old label", now)}); err != nil {
		t.Fatal(err)
	}
	withoutAccount := makeObservation(hubA, "empty-account", "", "Plan A", "Old label", now.Add(3*time.Hour))
	if err := lifecycle.InsertLimitObservations(ctx, []LimitObservation{withoutAccount}); err != nil {
		t.Fatal(err)
	}
	candidates, err := lifecycle.ListHubAccountCandidates(ctx, service.ID, domain.HubAccountCandidateUnconfirmed)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("Hub account candidates = %#v, want one per Hub", candidates)
	}
	for _, candidate := range candidates {
		if candidate.AccountKey != "account-key" || candidate.DisplayName != "" || candidate.DeviceName != "" {
			t.Fatalf("observation-derived Hub candidate leaked display evidence: %#v", candidate)
		}
	}
	identifications, err := lifecycle.ListIdentificationCandidates(ctx, domain.CandidateUnconfirmed)
	if err != nil {
		t.Fatal(err)
	}
	if len(identifications) != 1 || identifications[0].RawLimitServiceIdentifier != "limit.raw" || identifications[0].RawReportedPlanName != "Plan A" {
		t.Fatalf("identification candidates = %#v, want one exact raw plan candidate", identifications)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var evidence int
	if err := database.QueryRow(`SELECT count(*) FROM identification_candidate_observations`).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if evidence != 5 {
		t.Fatalf("identification candidate evidence rows = %d, want five observations", evidence)
	}
	labelCandidates, err := lifecycle.ListLimitLabelChangeCandidates(ctx, domain.LabelChangeUnconfirmed)
	if err != nil {
		t.Fatal(err)
	}
	if len(labelCandidates) != 1 || labelCandidates[0].ID != "candidate-source-new" || labelCandidates[0].OldLabel != "Old label" || labelCandidates[0].NewLabel != "New label" {
		t.Fatalf("observed label candidates = %#v", labelCandidates)
	}
	windows, err := lifecycle.ListLimitLabelChangeWindows(ctx, labelCandidates[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 3 {
		t.Fatalf("observed label windows = %#v, want old plus two new observations", windows)
	}
}
