package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// HubRow is the read model used by the Hub desktop service. It deliberately
// contains no credential value; Credential Manager is the only secret store.
type HubRow struct {
	Hub                   Hub
	ConnectionState       string
	ConnectionCheckedAt   *time.Time
	ConnectionFailureNote string
}

type CredentialAuditEvent struct {
	Sequence int64
	Action   string
}

func (l *Lifecycle) ListHubRows(ctx context.Context) ([]HubRow, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT h.hub_id, h.display_name, h.url, h.enabled, h.collection_enabled,
		       h.collection_interval_seconds, h.api_contract, h.created_at, h.updated_at,
		       s.state, s.checked_at, s.failure_detail
		FROM hubs h
		JOIN hub_connection_statuses s ON s.hub_id = h.hub_id
		ORDER BY h.created_at, h.hub_id`)
	if err != nil {
		return nil, fmt.Errorf("list Hubs: %w", err)
	}
	defer rows.Close()
	var result []HubRow
	for rows.Next() {
		var (
			hub                           Hub
			enabled, collectionEnabled    int
			apiContract, created, updated sql.NullString
			state, checked, failure       sql.NullString
		)
		if err := rows.Scan(&hub.ID, &hub.DisplayName, &hub.URL, &enabled, &collectionEnabled,
			&hub.CollectionIntervalSeconds, &apiContract, &created, &updated,
			&state, &checked, &failure); err != nil {
			return nil, fmt.Errorf("scan Hub: %w", err)
		}
		hub.Enabled = enabled != 0
		hub.CollectionEnabled = collectionEnabled != 0
		if apiContract.Valid {
			hub.APIContract = &apiContract.String
		}
		var parseErr error
		hub.CreatedAt, parseErr = parseUTC(created.String)
		if parseErr != nil {
			return nil, fmt.Errorf("parse Hub creation time: %w", parseErr)
		}
		hub.UpdatedAt, parseErr = parseUTC(updated.String)
		if parseErr != nil {
			return nil, fmt.Errorf("parse Hub update time: %w", parseErr)
		}
		row := HubRow{Hub: hub, ConnectionState: state.String, ConnectionFailureNote: failure.String}
		if checked.Valid && checked.String != "" {
			value, err := parseUTC(checked.String)
			if err != nil {
				return nil, fmt.Errorf("parse Hub connection time: %w", err)
			}
			row.ConnectionCheckedAt = &value
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Hubs: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) GetHubRow(ctx context.Context, hubID string) (HubRow, error) {
	rows, err := l.ListHubRows(ctx)
	if err != nil {
		return HubRow{}, err
	}
	for _, row := range rows {
		if row.Hub.ID == hubID {
			return row, nil
		}
	}
	return HubRow{}, errors.New("hub was not found")
}

func (l *Lifecycle) ListCredentialAuditEvents(ctx context.Context, hubID string) ([]CredentialAuditEvent, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT sequence, action FROM configuration_audits
		WHERE entity_id = ? AND action IN (
			'restore_succeeded', 'credential_saved', 'credential_deleted',
			'credential_reconfirmed', 'credential_save_started', 'credential_delete_started'
		)
		ORDER BY sequence`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list credential audit events: %w", err)
	}
	defer rows.Close()
	var events []CredentialAuditEvent
	for rows.Next() {
		var event CredentialAuditEvent
		if err := rows.Scan(&event.Sequence, &event.Action); err != nil {
			return nil, fmt.Errorf("scan credential audit event: %w", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read credential audit events: %w", err)
	}
	return events, nil
}

type CredentialAudit struct {
	AuditID    string
	OccurredAt time.Time
	Action     string
	HubID      string
	BeforeJSON string
	AfterJSON  string
}

type HubConnectionAttempt struct {
	AttemptID     string
	HubID         string
	CheckedAt     time.Time
	State         string
	APIContract   string
	FailureDetail string
}

func (l *Lifecycle) RecordHubConnectionAttempt(ctx context.Context, attempt HubConnectionAttempt) error {
	if attempt.AttemptID == "" || attempt.HubID == "" || attempt.CheckedAt.IsZero() || attempt.State == "" {
		return errors.New("hub connection attempt has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub connection result: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	contract := nullText(attempt.APIContract)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO hub_connection_attempts
			(attempt_id, hub_id, checked_at, state, api_contract, failure_detail)
		VALUES (?, ?, ?, ?, ?, ?)`,
		attempt.AttemptID, attempt.HubID, utcText(attempt.CheckedAt), attempt.State,
		contract, nullText(attempt.FailureDetail)); err != nil {
		return fmt.Errorf("insert Hub connection attempt: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE hub_connection_statuses
		SET state = ?, checked_at = ?, failure_detail = ? WHERE hub_id = ?`,
		attempt.State, utcText(attempt.CheckedAt), nullText(attempt.FailureDetail), attempt.HubID); err != nil {
		return fmt.Errorf("update Hub connection status: %w", err)
	}
	if attempt.APIContract != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE hubs SET api_contract = ?, updated_at = ? WHERE hub_id = ?`,
			attempt.APIContract, utcText(attempt.CheckedAt), attempt.HubID); err != nil {
			return fmt.Errorf("update Hub API contract: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub connection result: %w", err)
	}
	return nil
}

func nullText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (l *Lifecycle) AppendCredentialAudit(ctx context.Context, audit CredentialAudit) error {
	if audit.AuditID == "" || audit.Action == "" || audit.HubID == "" || audit.OccurredAt.IsZero() {
		return errors.New("credential audit has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	_, err = database.ExecContext(ctx, `
		INSERT INTO configuration_audits
			(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
		VALUES (?, ?, 'user', ?, 'hub_credential', ?, ?, ?)`,
		audit.AuditID, utcText(audit.OccurredAt), audit.Action, audit.HubID,
		nullJSON(audit.BeforeJSON), nullJSON(audit.AfterJSON))
	if err != nil {
		return fmt.Errorf("append credential audit: %w", err)
	}
	return nil
}

func nullJSON(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func parseUTC(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, errors.New("empty UTC timestamp")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}
