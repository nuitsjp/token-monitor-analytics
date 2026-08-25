package sqlite

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestListConfigurationAuditsUsesStableCursorAndFilters(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	for _, audit := range []struct {
		id, action, entityType, entityID, before, after string
		at                                              time.Time
	}{
		{"one", "update", "account", "account-1", `{"name":"before"}`, `{"name":"after"}`,
			time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)},
		{"two", "delete", "hub", "hub-1", `{"secret":"sentinel"}`, `{"credentialState":"unregistered"}`,
			time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)},
		{"three", "update", "account", "account-2", `{"name":"old"}`, `{"name":"new"}`,
			time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)},
	} {
		_, err := database.Exec(`INSERT INTO configuration_audits
			(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
			VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`, audit.id, utcText(audit.at), audit.action,
			audit.entityType, audit.entityID, audit.before, audit.after)
		if err != nil {
			t.Fatal(err)
		}
	}

	first, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 2 || first.Items[0].AuditID != "three" || first.Items[1].AuditID != "two" {
		t.Fatalf("first page = %#v", first.Items)
	}
	if !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page cursor = %#v", first)
	}
	second, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{Limit: 2, Cursor: first.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].AuditID != "one" || second.HasMore {
		t.Fatalf("second page = %#v", second)
	}

	from := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	filtered, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{
		Limit: 10, From: &from, To: &to, EntityType: "hub", Action: "delete",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Items) != 1 || filtered.Items[0].AuditID != "two" {
		t.Fatalf("filtered page = %#v", filtered.Items)
	}

	// The cursor must be applied together with the same filters. Otherwise a
	// page can skip the next matching row when unrelated records are inserted.
	filteredFrom := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	filteredTo := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	filteredFirst, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{
		Limit: 1, From: &filteredFrom, To: &filteredTo, EntityType: "account", Action: "update",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filteredFirst.Items) != 1 || filteredFirst.Items[0].AuditID != "three" || !filteredFirst.HasMore {
		t.Fatalf("filtered first page = %#v", filteredFirst)
	}
	filteredSecond, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{
		Limit: 1, Cursor: filteredFirst.NextCursor, From: &filteredFrom, To: &filteredTo,
		EntityType: "account", Action: "update",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filteredSecond.Items) != 1 || filteredSecond.Items[0].AuditID != "one" || filteredSecond.HasMore {
		t.Fatalf("filtered second page = %#v", filteredSecond)
	}
}

func TestListConfigurationAuditsRedactsSensitiveJSON(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`INSERT INTO configuration_audits
		(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
		VALUES ('sensitive', ?, 'user', 'update', 'hub', 'hub-1', ?, ?)`,
		utcText(time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)),
		`{"displayName":"safe","apiKey":"sentinel-secret","nested":{"password":"secret"}}`,
		`{"credentialState":"registered"}`)
	if err != nil {
		t.Fatal(err)
	}
	page, err := lifecycle.ListConfigurationAudits(context.Background(), AuditListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %#v", page.Items)
	}
	item := page.Items[0]
	if !strings.Contains(item.BeforeJSON, `"displayName":"safe"`) ||
		!strings.Contains(item.BeforeJSON, `"apiKey":"[非表示]"`) ||
		!strings.Contains(item.BeforeJSON, `"password":"[非表示]"`) {
		t.Fatalf("redacted before JSON = %s", item.BeforeJSON)
	}
	if strings.Contains(item.BeforeJSON, "sentinel-secret") {
		t.Fatalf("secret leaked in before JSON = %s", item.BeforeJSON)
	}
}
