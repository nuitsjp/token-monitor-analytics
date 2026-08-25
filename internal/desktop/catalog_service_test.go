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
