package sqlite

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestCredentialEventsMergeOneGlobalRestoreBoundaryBySequenceForEveryHub(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	defer lifecycle.Close()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	rows := []struct {
		auditID, action, entityType, entityID string
	}{
		{"hub-a-saved-before", "credential_saved", "hub_credential", "hub-a"},
		{"hub-b-saved-before", "credential_saved", "hub_credential", "hub-b"},
		{"restore-one", "restore_succeeded", "restore", "operation-one"},
		{"hub-a-saved-after", "credential_saved", "hub_credential", "hub-a"},
		{"hub-a-confirmed", "credential_reconfirmed", "hub_credential", "hub-a"},
	}
	for _, row := range rows {
		if _, err := database.Exec(`INSERT INTO configuration_audits
			(audit_id, occurred_at, actor, action, entity_type, entity_id)
			VALUES (?, ?, 'test', ?, ?, ?)`, row.auditID, now, row.action, row.entityType, row.entityID); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		hubID string
		want  domain.CredentialState
	}{
		{"hub-a", domain.CredentialRegistered},
		{"hub-b", domain.CredentialPostRestorePending},
	} {
		events, err := lifecycle.ListCredentialAuditEvents(context.Background(), test.hubID)
		if err != nil {
			t.Fatal(err)
		}
		domainEvents := make([]domain.CredentialEvent, len(events))
		for i, event := range events {
			domainEvents[i] = domain.CredentialEvent{Sequence: event.Sequence, Action: event.Action}
			if i > 0 && events[i-1].Sequence >= event.Sequence {
				t.Fatal("credential events are not ordered by audit sequence")
			}
		}
		if state := domain.DeriveCredentialState(domainEvents); state != test.want {
			t.Fatalf("Hub %s credential state = %q, want %q", test.hubID, state, test.want)
		}
	}
	var restoreCount int
	if err := database.QueryRow(`SELECT COUNT(*) FROM configuration_audits WHERE action = 'restore_succeeded'`).Scan(&restoreCount); err != nil {
		t.Fatal(err)
	}
	if restoreCount != 1 {
		t.Fatalf("restore audit count = %d, want 1", restoreCount)
	}
}
