package sqlite

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

func TestCatalogPersistsServicesMappingsAndCandidatesInFileDatabase(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := Service{ID: "service-1", Provider: "Provider", Name: "Service", OfficialKey: "official.service", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	from := now.Add(time.Hour)
	to := now.Add(2 * time.Hour)
	if err := lifecycle.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMapping{
		ID: "mapping-1", Kind: domain.UsageCostIdentifier, RawIdentifier: "cost.raw", ServiceID: service.ID,
		ValidFrom: from, ValidTo: &to, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	// Half-open adjacency is valid.
	if err := lifecycle.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMapping{
		ID: "mapping-2", Kind: domain.UsageCostIdentifier, RawIdentifier: "cost.raw", ServiceID: service.ID,
		ValidFrom: to, CreatedAt: now.Add(time.Minute),
	}); err != nil {
		t.Fatalf("adjacent mapping rejected: %v", err)
	}
	if err := lifecycle.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMapping{
		ID: "mapping-overlap", Kind: domain.UsageCostIdentifier, RawIdentifier: "cost.raw", ServiceID: service.ID,
		ValidFrom: from.Add(time.Minute), CreatedAt: now.Add(2 * time.Minute),
	}); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("overlapping mapping error = %v", err)
	}
	if err := lifecycle.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMapping{
		ID: "mapping-limit", Kind: domain.UsageLimitIdentifier, RawIdentifier: "limit.raw", ServiceID: service.ID,
		ValidFrom: from, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Run("DM-ID-02 cost and limit identifiers map separately", func(t *testing.T) {
		var cost, limit int
		if err := database.QueryRow(`SELECT count(*) FROM service_identifier_mappings WHERE identifier_kind = 'usage_cost'`).Scan(&cost); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRow(`SELECT count(*) FROM service_identifier_mappings WHERE identifier_kind = 'usage_limit'`).Scan(&limit); err != nil {
			t.Fatal(err)
		}
		if cost != 2 || limit != 1 {
			t.Fatalf("identifier mapping counts cost=%d limit=%d", cost, limit)
		}
	})
	t.Run("P1-CAT-01 lists raw identifier mappings", func(t *testing.T) {
		costRows, err := lifecycle.ListServiceIdentifierMappings(ctx, domain.UsageCostIdentifier, "")
		if err != nil {
			t.Fatal(err)
		}
		limitRows, err := lifecycle.ListServiceIdentifierMappings(ctx, domain.UsageLimitIdentifier, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(costRows) != 2 || len(limitRows) != 1 {
			t.Fatalf("identifier mapping rows cost=%#v limit=%#v", costRows, limitRows)
		}
	})
	t.Run("P1-CAT-04 registered service has a stable official key", func(t *testing.T) {
		var officialKey string
		if err := database.QueryRow(`SELECT official_key FROM services WHERE service_id = ?`, service.ID).Scan(&officialKey); err != nil {
			t.Fatal(err)
		}
		if service.ID == "" || officialKey != "official.service" {
			t.Fatalf("service catalog entry = %#v officialKey=%q", service, officialKey)
		}
	})

	candidate := IdentificationCandidate{
		ID: "candidate-1", RawLimitServiceIdentifier: "limit.raw", RawReportedPlanName: " Plan  A ",
		State: domain.CandidateUnconfirmed, CreatedAt: now, UpdatedAt: now,
	}
	if err := lifecycle.CreateIdentificationCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.UpsertIdentificationCandidate(ctx, IdentificationCandidate{
		ID: candidate.ID, RawLimitServiceIdentifier: candidate.RawLimitServiceIdentifier, RawReportedPlanName: candidate.RawReportedPlanName,
		State: domain.CandidateUnconfirmed, FirstObservedAt: ptrTime(from), LastObservedAt: ptrTime(to), CreatedAt: now, UpdatedAt: to,
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListIdentificationCandidates(ctx, domain.CandidateUnconfirmed)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("DM-ID-03 candidate preserves exact raw identifier and plan", func(t *testing.T) {
		if len(rows) != 1 || rows[0].RawReportedPlanName != " Plan  A " || rows[0].FirstObservedAt == nil || rows[0].LastObservedAt == nil {
			t.Fatalf("candidate rows = %#v", rows)
		}
	})
}

func TestCatalogRejectsPlanVersionAndPriceOverlapAndReversePeriods(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "service-1")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	plan := Plan{ID: "plan-1", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	start := now.Add(time.Hour)
	end := now.Add(3 * time.Hour)
	version := PlanVersion{ID: "version-1", PlanID: plan.ID, Name: "v1", ValidFrom: start, ValidTo: &end, OfficialSourceURL: "https://vendor.example/plans", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	reverseEnd := start.Add(-time.Minute)
	if err := lifecycle.CreatePlanVersion(ctx, PlanVersion{ID: "version-reverse", PlanID: plan.ID, Name: "bad", ValidFrom: start, ValidTo: &reverseEnd, OfficialSourceURL: "https://vendor.example/plans", CreatedAt: now}); err == nil {
		t.Fatal("reverse plan version was accepted")
	}
	overlapStart := start.Add(time.Hour)
	if err := lifecycle.CreatePlanVersion(ctx, PlanVersion{ID: "version-overlap", PlanID: plan.ID, Name: "bad", ValidFrom: overlapStart, OfficialSourceURL: "https://vendor.example/plans", CreatedAt: now}); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("overlapping plan version error = %v", err)
	}
	adjacentStart := end
	adjacentEnd := end.Add(time.Hour)
	if err := lifecycle.CreatePlanVersion(ctx, PlanVersion{ID: "version-2", PlanID: plan.ID, Name: "v2", ValidFrom: adjacentStart, ValidTo: &adjacentEnd, OfficialSourceURL: "https://vendor.example/plans", CreatedAt: now}); err != nil {
		t.Fatalf("adjacent plan version rejected: %v", err)
	}
	t.Run("DM-PLAN-02 plan versions reject overlap and allow adjacency", func(t *testing.T) {
		if !adjacentStart.Equal(end) || !adjacentEnd.After(adjacentStart) {
			t.Fatalf("adjacent period = %s..%s", adjacentStart, adjacentEnd)
		}
		if err := lifecycle.CreatePlanVersion(ctx, PlanVersion{ID: "version-check-overlap", PlanID: plan.ID, Name: "overlap", ValidFrom: start.Add(30 * time.Minute), OfficialSourceURL: "https://vendor.example/plans", CreatedAt: now}); err == nil {
			t.Fatal("overlapping plan version was accepted")
		}
	})

	priceEnd := start.Add(time.Hour)
	if err := lifecycle.CreateStandardPrice(ctx, StandardPrice{ID: "price-1", PlanVersionID: version.ID, USDMonthlyPerSeat: 20, SourceURL: "https://vendor.example/prices", ValidFrom: start, ValidTo: &priceEnd, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	priceAdjacent := priceEnd
	if err := lifecycle.CreateStandardPrice(ctx, StandardPrice{ID: "price-2", PlanVersionID: version.ID, USDMonthlyPerSeat: 25, SourceURL: "https://vendor.example/prices", ValidFrom: priceAdjacent, CreatedAt: now}); err != nil {
		t.Fatalf("adjacent standard price rejected: %v", err)
	}
	if err := lifecycle.CreateStandardPrice(ctx, StandardPrice{ID: "price-overlap", PlanVersionID: version.ID, USDMonthlyPerSeat: 30, SourceURL: "https://vendor.example/prices", ValidFrom: start.Add(30 * time.Minute), CreatedAt: now}); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("overlapping standard price error = %v", err)
	}
}

func TestCatalogUpdatesStandardPriceWithAuditAndRecalculationScope(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "price-service")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	plan := Plan{ID: "price-plan", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	version := PlanVersion{ID: "price-version", PlanID: plan.ID, Name: "v1", ValidFrom: now, OfficialSourceURL: "https://vendor.example/plan", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, version); err != nil {
		t.Fatal(err)
	}
	price := StandardPrice{ID: "price-edit", PlanVersionID: version.ID, USDMonthlyPerSeat: 20, SourceURL: "https://vendor.example/old-price", ValidFrom: now, CreatedAt: now}
	if err := lifecycle.CreateStandardPrice(ctx, price); err != nil {
		t.Fatal(err)
	}
	price.USDMonthlyPerSeat = 25
	price.SourceURL = "https://vendor.example/new-price"
	if err := lifecycle.UpdateStandardPrice(ctx, price); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListStandardPrices(ctx, version.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].USDMonthlyPerSeat != 25 || rows[0].SourceURL != price.SourceURL || !rows[0].CreatedAt.Equal(now) {
		t.Fatalf("updated standard price = %#v", rows)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var audits, requests int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits WHERE entity_type = 'catalog_standard_price' AND action = 'update' AND entity_id = ?`, price.ID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests WHERE audit_id IN (SELECT audit_id FROM configuration_audits WHERE entity_type = 'catalog_standard_price' AND action = 'update' AND entity_id = ?)`, price.ID).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	if audits != 1 || requests != 1 {
		t.Fatalf("standard price update audit/request = %d/%d", audits, requests)
	}
}

func TestCatalogEnforcesCrossServiceReferencesAndCandidateDecision(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	serviceA := testCatalogService(now, "service-a")
	serviceB := testCatalogService(now, "service-b")
	serviceB.OfficialKey = "official.service.b"
	if err := lifecycle.CreateService(ctx, serviceA); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreateService(ctx, serviceB); err != nil {
		t.Fatal(err)
	}
	planA := Plan{ID: "plan-a", ServiceID: serviceA.ID, Name: "Plan A", CreatedAt: now, UpdatedAt: now}
	planB := Plan{ID: "plan-b", ServiceID: serviceA.ID, Name: "Plan B", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, planA); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.CreatePlan(ctx, planB); err != nil {
		t.Fatal(err)
	}
	t.Run("DM-PLAN-01 supports multiple plans per service", func(t *testing.T) {
		if planA.ServiceID != planB.ServiceID || planA.ID == planB.ID {
			t.Fatalf("plans were not kept distinct: A=%#v B=%#v", planA, planB)
		}
	})
	versionA := PlanVersion{ID: "version-a", PlanID: planA.ID, Name: "A", ValidFrom: now, OfficialSourceURL: "https://vendor.example/a", CreatedAt: now}
	if err := lifecycle.CreatePlanVersion(ctx, versionA); err != nil {
		t.Fatal(err)
	}
	definitionB := LimitDefinition{ID: "limit-b", ServiceID: serviceB.ID, CycleType: "weekly", Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definitionB); err != nil {
		t.Fatal(err)
	}
	multiplier := 2.0
	t.Run("DM-PLAN-07 plan limit rules do not cross services", func(t *testing.T) {
		if err := lifecycle.CreatePlanLimitRule(ctx, PlanLimitRule{ID: "rule-cross-service", PlanVersionID: versionA.ID, LimitDefinitionID: definitionB.ID, Multiplier: &multiplier, OfficialSourceURL: "https://vendor.example/rules", CreatedAt: now}); err == nil || !strings.Contains(err.Error(), "different services") {
			t.Fatalf("cross-service rule error = %v", err)
		}
	})
	t.Run("DM-PLAN-05 limit definition belongs to one service", func(t *testing.T) {
		if definitionB.ServiceID != serviceB.ID || planA.ServiceID == definitionB.ServiceID {
			t.Fatalf("definition service = %q, plan service = %q", definitionB.ServiceID, planA.ServiceID)
		}
	})

	candidate := IdentificationCandidate{ID: "candidate-confirm", RawLimitServiceIdentifier: "limit", RawReportedPlanName: "Plan A", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateIdentificationCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ConfirmIdentificationCandidate(ctx, candidate.ID, serviceA.ID, planA.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.RejectIdentificationCandidate(ctx, candidate.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListIdentificationCandidates(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-CAT-03 candidate decision can be revoked to rejected", func(t *testing.T) {
		if len(rows) != 1 || rows[0].State != domain.CandidateRejected || rows[0].ServiceID != nil || rows[0].PlanID != nil {
			t.Fatalf("candidate after rejection = %#v", rows)
		}
	})
}

func TestCatalogDomainRejectsNonFiniteAndInvalidSourceValues(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	nan := domain.PlanLimitRule{ID: "rule", PlanVersionID: "version", LimitDefinitionID: "limit", Multiplier: ptrFloat(0), OfficialSourceURL: "https://vendor.example/rule", CreatedAt: now}
	if err := nan.Validate(); err == nil {
		t.Fatal("zero multiplier was accepted")
	}
	price := domain.StandardPrice{ID: "price", PlanVersionID: "version", USDMonthlyPerSeat: 10, SourceURL: "https://vendor.example/price?x=1#published", ValidFrom: now, CreatedAt: now}
	if err := price.Validate(); err != nil {
		t.Fatalf("official source URL with query/fragment was rejected: %v", err)
	}
}

func TestCatalogSupportsCandidateReleaseCorrectionSplitAndLabelChangeEvidence(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES (?, 'Hub', 'https://hub.example', 1, 300, ?, ?)`, hubID, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hub_connection_statuses (hub_id, state) VALUES (?, 'not_checked')`, hubID); err != nil {
		t.Fatal(err)
	}
	service := testCatalogService(now, "service-1")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	plan := Plan{ID: "plan-1", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	candidate := IdentificationCandidate{ID: "candidate-1", RawLimitServiceIdentifier: "provider.raw", RawReportedPlanName: "Plan A", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateIdentificationCandidate(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ConfirmIdentificationCandidate(ctx, candidate.ID, service.ID, plan.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ReleaseIdentificationCandidate(ctx, candidate.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.UpdateIdentificationCandidate(ctx, candidate.ID, "provider.raw.changed", "Plan A exact", now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.AddIdentificationCandidateObservation(ctx, "obs-1", candidate.ID, hubID, "", now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SplitIdentificationCandidate(ctx, candidate.ID, IdentificationCandidate{ID: "candidate-split", RawLimitServiceIdentifier: "provider.raw.changed", RawReportedPlanName: "Plan A exact", CreatedAt: now.Add(4 * time.Minute), UpdatedAt: now.Add(4 * time.Minute)}, "obs-1"); err != nil {
		t.Fatal(err)
	}
	t.Run("P1-CAT-03 candidate can be confirmed released corrected and split", func(t *testing.T) {
		rows, err := lifecycle.ListIdentificationCandidates(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 2 {
			t.Fatalf("candidate correction rows = %#v", rows)
		}
	})
	t.Run("P1-CAT-09 split preserves correction target", func(t *testing.T) {
		rows, err := lifecycle.ListIdentificationCandidates(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range rows {
			if row.ID == "candidate-split" && row.RawLimitServiceIdentifier == "provider.raw.changed" {
				found = true
			}
		}
		if !found {
			t.Fatalf("split candidate not found: %#v", rows)
		}
	})

	limit := LimitDefinition{ID: "limit-1", ServiceID: service.ID, CycleType: "weekly", Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, limit); err != nil {
		t.Fatal(err)
	}
	labelCandidate := LimitLabelChangeCandidate{ID: "label-candidate", HubID: hubID, DeviceRecordKey: "device-1", HubAccountKey: "", RawLimitServiceIdentifier: "provider.raw", NormalizedKind: "window", NormalizedMetric: "percent", OldLabel: "旧表示", NewLabel: "新表示", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitLabelChangeCandidate(ctx, labelCandidate); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.AddLimitLabelChangeWindow(ctx, LimitLabelChangeWindow{ID: "window-old", CandidateID: labelCandidate.ID, WindowKey: "w1", Label: "旧表示", ObservedAt: now.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	// Missing Hub account display information is allowed and remains non-secret.
	if err := lifecycle.DecideLimitLabelChangeCandidate(ctx, labelCandidate.ID, domain.LabelChangeSameLimit, limit.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	labelRows, err := lifecycle.ListLimitLabelChangeCandidates(ctx, domain.LabelChangeSameLimit)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("DM-PLAN-10 label change candidate retains old and new evidence", func(t *testing.T) {
		if len(labelRows) != 1 || labelRows[0].LimitDefinitionID == nil || *labelRows[0].LimitDefinitionID != limit.ID {
			t.Fatalf("label change candidates = %#v", labelRows)
		}
	})
	windows, err := lifecycle.ListLimitLabelChangeWindows(ctx, labelCandidate.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 1 || windows[0].Label != "旧表示" {
		t.Fatalf("label change windows = %#v", windows)
	}

	var audits, requests int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits WHERE entity_type IN ('catalog_identification_candidate', 'catalog_limit_label_change_candidate')`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests`).Scan(&requests); err != nil {
		t.Fatal(err)
	}
	t.Run("DM-REL-03 catalog changes append audit and recalculation records", func(t *testing.T) {
		if audits == 0 || requests < audits {
			t.Fatalf("catalog audits=%d requests=%d", audits, requests)
		}
		var actor, occurred, before, after string
		if err := database.QueryRow(`SELECT actor, occurred_at, COALESCE(before_json, ''), COALESCE(after_json, '') FROM configuration_audits WHERE entity_type = 'catalog_identification_candidate' ORDER BY sequence DESC LIMIT 1`).Scan(&actor, &occurred, &before, &after); err != nil {
			t.Fatal(err)
		}
		if actor == "" || occurred == "" || before == "" || after == "" {
			t.Fatalf("audit fields actor=%q occurred=%q before=%q after=%q", actor, occurred, before, after)
		}
	})
}

func TestSplitRecomputesBothObservationRangesAndRollsBackInvalidSelection(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	hubID := uuid.NewString()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES (?, 'Hub', 'https://hub.example', 1, 300, ?, ?)`, hubID, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO hub_connection_statuses (hub_id, state) VALUES (?, 'not_checked')`, hubID); err != nil {
		t.Fatal(err)
	}
	createCandidate := func(id string) {
		t.Helper()
		if err := lifecycle.CreateIdentificationCandidate(ctx, IdentificationCandidate{ID: id, RawLimitServiceIdentifier: "raw", RawReportedPlanName: "Plan", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	createCandidate("source")
	for index, observedAt := range []time.Time{now.Add(time.Hour), now.Add(2 * time.Hour), now.Add(3 * time.Hour)} {
		if err := lifecycle.AddIdentificationCandidateObservation(ctx, fmt.Sprintf("source-observation-%d", index), "source", hubID, "", observedAt); err != nil {
			t.Fatal(err)
		}
	}
	if err := lifecycle.SplitIdentificationCandidate(ctx, "source", IdentificationCandidate{ID: "split", RawLimitServiceIdentifier: "raw", RawReportedPlanName: "Plan", CreatedAt: now, UpdatedAt: now.Add(4 * time.Hour)}, "source-observation-0", "source-observation-1"); err != nil {
		t.Fatal(err)
	}
	rows, err := lifecycle.ListIdentificationCandidates(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-CAT-09 split creates both corrected observation ranges", func(t *testing.T) {
		if len(rows) != 2 {
			t.Fatalf("candidate count = %d, want 2", len(rows))
		}
	})
	byID := make(map[string]IdentificationCandidate, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	t.Run("P1-CAT-09 split recomputes both source bounds", func(t *testing.T) {
		if byID["source"].FirstObservedAt == nil || !byID["source"].FirstObservedAt.Equal(now.Add(3*time.Hour)) || byID["source"].LastObservedAt == nil || !byID["source"].LastObservedAt.Equal(now.Add(3*time.Hour)) {
			t.Fatalf("source bounds = %#v", byID["source"])
		}
		if byID["split"].FirstObservedAt == nil || !byID["split"].FirstObservedAt.Equal(now.Add(time.Hour)) || byID["split"].LastObservedAt == nil || !byID["split"].LastObservedAt.Equal(now.Add(2*time.Hour)) {
			t.Fatalf("split bounds = %#v", byID["split"])
		}
	})
	if err := lifecycle.UpsertIdentificationCandidate(ctx, IdentificationCandidate{ID: "split", RawLimitServiceIdentifier: "raw", RawReportedPlanName: "Plan", FirstObservedAt: ptrTime(now.Add(4 * time.Hour)), LastObservedAt: ptrTime(now.Add(4 * time.Hour)), CreatedAt: now, UpdatedAt: now.Add(4 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.UpsertIdentificationCandidate(ctx, IdentificationCandidate{RawLimitServiceIdentifier: "raw", RawReportedPlanName: "Plan", FirstObservedAt: ptrTime(now.Add(5 * time.Hour)), LastObservedAt: ptrTime(now.Add(5 * time.Hour)), CreatedAt: now, UpdatedAt: now.Add(5 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	rows, err = lifecycle.ListIdentificationCandidates(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	byID = make(map[string]IdentificationCandidate, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	if !byID["split"].LastObservedAt.Equal(now.Add(4*time.Hour)) || !byID["source"].LastObservedAt.Equal(now.Add(5*time.Hour)) {
		t.Fatalf("deterministic split routing bounds = %#v", byID)
	}
	for _, observationID := range []string{"source-observation-0", "source-observation-1"} {
		var owner string
		if err := database.QueryRow(`SELECT candidate_id FROM identification_candidate_observations WHERE observation_id = ?`, observationID).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if owner != "split" {
			t.Fatalf("%s owner = %q, want split", observationID, owner)
		}
	}

	createCandidate("other")
	if err := lifecycle.AddIdentificationCandidateObservation(ctx, "other-observation", "other", hubID, "", now.Add(5*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SplitIdentificationCandidate(ctx, "source", IdentificationCandidate{ID: "invalid-split", RawLimitServiceIdentifier: "raw", RawReportedPlanName: "Plan", CreatedAt: now, UpdatedAt: now}, "other-observation"); err == nil {
		t.Fatal("split accepted an observation from another candidate")
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM identification_candidates WHERE candidate_id = 'invalid-split'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	t.Run("P1-CAT-03 invalid split selection rolls back", func(t *testing.T) {
		if count != 0 {
			t.Fatalf("invalid split candidate count = %d", count)
		}
	})
	var owner string
	if err := database.QueryRow(`SELECT candidate_id FROM identification_candidate_observations WHERE observation_id = 'other-observation'`).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != "other" {
		t.Fatalf("other observation owner after rollback = %q", owner)
	}
}

func TestCatalogEditsAndArchivesLimitDefinitionAndPlan(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service := testCatalogService(now, "service-edit")
	if err := lifecycle.CreateService(ctx, service); err != nil {
		t.Fatal(err)
	}
	definition := LimitDefinition{ID: "limit-edit", ServiceID: service.ID, CycleType: "weekly", Meaning: "tokens", Unit: "percent", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	definition.Meaning = "tokens-renamed"
	definition.UpdatedAt = now.Add(time.Minute)
	if err := lifecycle.UpdateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ArchiveLimitDefinition(ctx, definition.ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	activeDefinitions, err := lifecycle.ListLimitDefinitions(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeDefinitions) != 0 {
		t.Fatalf("active definitions after archive = %#v", activeDefinitions)
	}
	allDefinitions, err := lifecycle.ListLimitDefinitions(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(allDefinitions) != 1 || allDefinitions[0].ArchivedAt == nil || allDefinitions[0].Meaning != "tokens-renamed" {
		t.Fatalf("archived definitions = %#v", allDefinitions)
	}
	definition = allDefinitions[0]
	definition.ArchivedAt = nil
	definition.UpdatedAt = now.Add(3 * time.Minute)
	if err := lifecycle.UpdateLimitDefinition(ctx, definition); err != nil {
		t.Fatal(err)
	}

	plan := Plan{ID: "plan-edit", ServiceID: service.ID, Name: "Plan", CreatedAt: now, UpdatedAt: now}
	if err := lifecycle.CreatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	plan.Name = "Plan renamed"
	plan.UpdatedAt = now.Add(4 * time.Minute)
	if err := lifecycle.UpdatePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.ArchivePlan(ctx, plan.ID, now.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	activePlans, err := lifecycle.ListPlans(ctx, service.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(activePlans) != 0 {
		t.Fatalf("active plans after archive = %#v", activePlans)
	}
	allPlans, err := lifecycle.ListPlans(ctx, service.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(allPlans) != 1 || allPlans[0].ArchivedAt == nil || allPlans[0].Name != "Plan renamed" {
		t.Fatalf("archived plans = %#v", allPlans)
	}
}

func testCatalogService(now time.Time, id string) Service {
	return Service{ID: id, Provider: "Provider", Name: id, OfficialKey: "official." + id, CreatedAt: now, UpdatedAt: now}
}

func ptrTime(value time.Time) *time.Time { return &value }

func ptrFloat(value float64) *float64 { return &value }
