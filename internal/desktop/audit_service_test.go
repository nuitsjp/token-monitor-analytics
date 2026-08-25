package desktop

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/adapter/sqlite"
)

func TestAuditServiceReturnsUTCAndRedactedBeforeAfter(t *testing.T) {
	lifecycle := &sqlite.Lifecycle{}
	if err := lifecycle.Open(context.Background(), t.TempDir()+"/data.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`INSERT INTO configuration_audits
		(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
		VALUES ('audit-1', ?, 'user', 'update', 'account', 'account-1', ?, ?)`,
		time.Date(2026, 8, 1, 9, 0, 0, 123456789, time.FixedZone("JST", 9*60*60)).Format(time.RFC3339Nano),
		`{"name":"old","secret":"do-not-show"}`, `{"name":"new"}`)
	if err != nil {
		t.Fatal(err)
	}
	page, err := NewAuditService(lifecycle).GetAudits(context.Background(), AuditFilterInput{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].OccurredAt != "2026-08-01T00:00:00.123456789Z" {
		t.Fatalf("page = %#v", page)
	}
	if page.Items[0].BeforeJSON == "" || page.Items[0].AfterJSON == "" {
		t.Fatalf("before/after were not returned: %#v", page.Items[0])
	}
	if page.Items[0].BeforeJSON == `{"name":"old","secret":"do-not-show"}` {
		t.Fatal("sensitive before JSON was returned")
	}
}

func TestAuditServiceRejectsInvalidDateRange(t *testing.T) {
	lifecycle := &sqlite.Lifecycle{}
	if err := lifecycle.Open(context.Background(), t.TempDir()+"/data.db"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	_, err := NewAuditService(lifecycle).GetAudits(context.Background(), AuditFilterInput{
		From: "2026-08-03T00:00:00Z", To: "2026-08-01T00:00:00Z",
	})
	if err == nil {
		t.Fatal("invalid date range was accepted")
	}
}
