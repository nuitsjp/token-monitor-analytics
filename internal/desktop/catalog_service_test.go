package desktop

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
)

func TestCatalogServiceUpdatesPreserveImmutableFieldsAndUseInjectedClock(t *testing.T) {
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "catalog.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	clock := fixedClock{value: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)}
	service, err := NewCatalogServiceWithDependencies(lifecycle, clock, randomIDs{}, newDesktopTestMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	created, err := service.CreateService(ctx, CreateServiceInput{Provider: "Provider", Name: "Service", OfficialKey: "official.service"})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMappingInput{ID: "mapping-1", Kind: "usage_limit", RawIdentifier: "raw-limit", ServiceID: created.ID, ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreateLimitDefinition(ctx, LimitDefinitionInput{ID: "limit-1", ServiceID: created.ID, CycleType: "billing", Meaning: "tokens", Unit: "percent", BillingConfirmation: "unconfirmed"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreatePlan(ctx, PlanInput{ID: "plan-1", ServiceID: created.ID, Name: "Plan"}); err != nil {
		t.Fatal(err)
	}
	if err := service.SetBaselinePlan(ctx, created.ID, "plan-1"); err != nil {
		t.Fatal(err)
	}
	if err := service.CreatePlanVersion(ctx, PlanVersionInput{ID: "version-1", PlanID: "plan-1", Name: "v1", ValidFrom: "2026-08-01T00:00:00Z", OfficialSourceURL: "https://vendor.example/plan"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreateStandardPrice(ctx, StandardPriceInput{ID: "price-1", PlanVersionID: "version-1", USDMonthlyPerSeat: 20, SourceURL: "https://vendor.example/old-price", ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := service.UpdateStandardPrice(ctx, StandardPriceInput{ID: "price-1", PlanVersionID: "version-1", USDMonthlyPerSeat: 25, SourceURL: "https://vendor.example/new-price", ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}

	if err := service.UpdateServiceIdentifierMapping(ctx, ServiceIdentifierMappingInput{ID: "mapping-1", Kind: "usage_limit", RawIdentifier: "raw-limit-renamed", ServiceID: created.ID, ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := service.UpdateLimitDefinition(ctx, LimitDefinitionInput{ID: "limit-1", ServiceID: created.ID, CycleType: "billing", Meaning: "tokens-updated", Unit: "percent", BillingConfirmation: "unconfirmed"}); err != nil {
		t.Fatal(err)
	}
	if err := service.UpdatePlan(ctx, PlanInput{ID: "plan-1", ServiceID: created.ID, Name: "Plan-updated", IsBaseline: false}); err != nil {
		t.Fatal(err)
	}

	mappings, err := lifecycle.ListServiceIdentifierMappings(ctx, "usage_limit", "raw-limit-renamed")
	if err != nil || len(mappings) != 1 || mappings[0].CreatedAt.IsZero() {
		t.Fatalf("updated mapping = %#v, err = %v", mappings, err)
	}
	definitions, err := lifecycle.ListLimitDefinitions(ctx, true)
	if err != nil || len(definitions) != 1 || definitions[0].CreatedAt.IsZero() || definitions[0].Meaning != "tokens-updated" {
		t.Fatalf("updated definition = %#v, err = %v", definitions, err)
	}
	plans, err := lifecycle.ListPlans(ctx, created.ID, true)
	if err != nil || len(plans) != 1 || plans[0].CreatedAt.IsZero() || plans[0].Name != "Plan-updated" || !plans[0].IsBaseline {
		t.Fatalf("updated plan = %#v, err = %v", plans, err)
	}
	prices, err := lifecycle.ListStandardPrices(ctx, "version-1")
	if err != nil || len(prices) != 1 || prices[0].USDMonthlyPerSeat != 25 || prices[0].SourceURL != "https://vendor.example/new-price" || prices[0].CreatedAt.IsZero() {
		t.Fatalf("updated standard price = %#v, err = %v", prices, err)
	}
	t.Run("P2-VALUE-00 standard price is registered and edited with source metadata", func(t *testing.T) {
		if len(prices) != 1 || prices[0].PlanVersionID != "version-1" || prices[0].USDMonthlyPerSeat != 25 || prices[0].SourceURL != "https://vendor.example/new-price" || prices[0].ValidFrom.IsZero() {
			t.Fatalf("standard price metadata = %#v", prices)
		}
	})
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	var auditCount, requestCount, fixedAuditCount int
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM recalculation_requests`).Scan(&requestCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT count(*) FROM configuration_audits WHERE occurred_at = ?`, clock.value.Format(time.RFC3339Nano)).Scan(&fixedAuditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount < 7 || requestCount < 7 || fixedAuditCount < 7 {
		t.Fatalf("audit/request counts = %d/%d, fixed clock audits = %d", auditCount, requestCount, fixedAuditCount)
	}
}

func TestCatalogServiceRoundTripsCompleteSnapshotThroughSQLite(t *testing.T) {
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(t.Context(), filepath.Join(t.TempDir(), "catalog-snapshot.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	clock := fixedClock{value: time.Date(2026, 8, 29, 1, 2, 3, 4, time.UTC)}
	service, err := NewCatalogServiceWithDependencies(lifecycle, clock, randomIDs{}, newDesktopTestMaintenanceGate())
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	created, err := service.CreateService(ctx, CreateServiceInput{Provider: "Provider", Name: "Service", OfficialKey: "provider.service"})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.CreateServiceIdentifierMapping(ctx, ServiceIdentifierMappingInput{ID: "mapping-1", Kind: "usage_limit", RawIdentifier: "raw.limit", ServiceID: created.ID, ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreateLimitDefinition(ctx, LimitDefinitionInput{ID: "definition-1", ServiceID: created.ID, CycleType: "billing", Meaning: "Monthly", Unit: "percent", BillingConfirmation: "unconfirmed"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreatePlan(ctx, PlanInput{ID: "plan-1", ServiceID: created.ID, Name: "Plan"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreatePlanVersion(ctx, PlanVersionInput{ID: "version-1", PlanID: "plan-1", Name: "v1", ValidFrom: "2026-08-01T00:00:00Z", OfficialSourceURL: "https://vendor.example/plan"}); err != nil {
		t.Fatal(err)
	}
	limit := 100.0
	if err := service.CreatePlanLimitRule(ctx, PlanLimitRuleInput{ID: "rule-1", PlanVersionID: "version-1", LimitDefinitionID: "definition-1", Limit: &limit, OfficialSourceURL: "https://vendor.example/limit"}); err != nil {
		t.Fatal(err)
	}
	if err := service.CreateStandardPrice(ctx, StandardPriceInput{ID: "price-1", PlanVersionID: "version-1", USDMonthlyPerSeat: 20, SourceURL: "https://vendor.example/price", ValidFrom: "2026-08-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}

	snapshot, err := service.GetCatalog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Services) != 1 || len(snapshot.ServiceIdentifierMappings) != 1 || len(snapshot.LimitDefinitions) != 1 || len(snapshot.Plans) != 1 || len(snapshot.PlanVersions) != 1 || len(snapshot.PlanLimitRules) != 1 || len(snapshot.StandardPrices) != 1 {
		t.Fatalf("catalog snapshot = %#v", snapshot)
	}
	if snapshot.PlanLimitRules[0].Limit == nil || *snapshot.PlanLimitRules[0].Limit != limit || snapshot.StandardPrices[0].USDMonthlyPerSeat != 20 {
		t.Fatalf("catalog value DTOs = rules %#v, prices %#v", snapshot.PlanLimitRules, snapshot.StandardPrices)
	}

	if err := service.SetBillingConfirmation(ctx, "definition-1", "confirmed"); err != nil {
		t.Fatal(err)
	}
	definitions, err := service.GetLimitDefinitions(ctx, false)
	if err != nil || len(definitions) != 1 || definitions[0].BillingConfirmation != "confirmed" {
		t.Fatalf("billing confirmation = %#v, err = %v", definitions, err)
	}
	if err := service.ArchiveService(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	active, err := service.GetServices(ctx, false)
	if err != nil || len(active) != 0 {
		t.Fatalf("active services after archive = %#v, err = %v", active, err)
	}
	archived, err := service.GetServices(ctx, true)
	if err != nil || len(archived) != 1 || archived[0].ArchivedAt == "" {
		t.Fatalf("archived services = %#v, err = %v", archived, err)
	}
	if err := service.RestoreService(ctx, created.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := service.GetServices(ctx, false)
	if err != nil || len(restored) != 1 || restored[0].ArchivedAt != "" {
		t.Fatalf("restored services = %#v, err = %v", restored, err)
	}
}
