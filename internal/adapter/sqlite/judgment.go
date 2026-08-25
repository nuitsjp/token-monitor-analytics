package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type FailureInjector interface {
	Check(point string) error
}

type JudgmentChange struct {
	AuditID       string
	RequestID     string
	Actor         string
	Action        string
	EntityType    string
	EntityID      string
	State         string
	Reason        string
	OccurredAt    time.Time
	IntervalStart time.Time
	IntervalEnd   time.Time
}

type judgmentSnapshot struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

func (l *Lifecycle) SaveJudgment(ctx context.Context, change JudgmentChange, injector FailureInjector) error {
	if err := validateJudgmentChange(change); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin judgment change: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var previous judgmentSnapshot
	err = tx.QueryRowContext(ctx,
		`SELECT state, COALESCE(reason, '') FROM judgments WHERE entity_type = ? AND entity_id = ?`,
		change.EntityType, change.EntityID,
	).Scan(&previous.State, &previous.Reason)
	var beforeJSON any
	if err == nil {
		beforeJSON = previous
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read previous judgment: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO judgments (entity_type, entity_id, state, reason, updated_at)
		VALUES (?, ?, ?, NULLIF(?, ''), ?)
		ON CONFLICT (entity_type, entity_id) DO UPDATE SET
			state = excluded.state,
			reason = excluded.reason,
			updated_at = excluded.updated_at`,
		change.EntityType, change.EntityID, change.State, change.Reason, utcText(change.OccurredAt),
	)
	if err != nil {
		return fmt.Errorf("save judgment: %w", err)
	}
	if err := inject(injector, "after-change"); err != nil {
		return err
	}

	before, err := optionalJSON(beforeJSON)
	if err != nil {
		return err
	}
	after, err := optionalJSON(judgmentSnapshot{State: change.State, Reason: change.Reason})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO configuration_audits
			(audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		change.AuditID, utcText(change.OccurredAt), change.Actor, change.Action,
		change.EntityType, change.EntityID, before, after,
	)
	if err != nil {
		return fmt.Errorf("append configuration audit: %w", err)
	}
	if err := inject(injector, "after-audit"); err != nil {
		return err
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO recalculation_requests
			(request_id, audit_id, requested_at, interval_start, interval_end, state)
		VALUES (?, ?, ?, ?, ?, 'pending')`,
		change.RequestID, change.AuditID, utcText(change.OccurredAt),
		utcText(change.IntervalStart), utcText(change.IntervalEnd),
	)
	if err != nil {
		return fmt.Errorf("append recalculation request: %w", err)
	}
	if err := inject(injector, "after-recalculation-request"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit judgment change: %w", err)
	}
	return nil
}

func validateJudgmentChange(change JudgmentChange) error {
	if change.AuditID == "" || change.RequestID == "" || change.Actor == "" ||
		change.Action == "" || change.EntityType == "" || change.EntityID == "" || change.State == "" {
		return errors.New("judgment change has an empty required field")
	}
	if change.OccurredAt.IsZero() || change.IntervalStart.IsZero() || change.IntervalEnd.IsZero() {
		return errors.New("judgment change has an empty timestamp")
	}
	if !change.IntervalStart.Before(change.IntervalEnd) {
		return errors.New("recalculation interval must be non-empty")
	}
	return nil
}

func optionalJSON(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode audit JSON: %w", err)
	}
	return string(encoded), nil
}

func utcText(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func inject(injector FailureInjector, point string) error {
	if injector == nil {
		return nil
	}
	if err := injector.Check(point); err != nil {
		return fmt.Errorf("injected failure at %s: %w", point, err)
	}
	return nil
}
