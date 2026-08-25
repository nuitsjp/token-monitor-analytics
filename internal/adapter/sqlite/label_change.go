package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

type LimitLabelChangeCandidate = domain.LimitLabelChangeCandidate
type LimitLabelChangeWindow = domain.LimitLabelChangeWindow

func (l *Lifecycle) CreateLimitLabelChangeCandidate(ctx context.Context, candidate LimitLabelChangeCandidate) error {
	if candidate.State == "" {
		candidate.State = domain.LabelChangeUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin label change candidate creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO limit_label_change_candidates
			(candidate_id, hub_id, device_record_key, hub_account_key, raw_limit_service_identifier,
			 normalized_kind, normalized_metric, old_label, new_label, state, limit_definition_id,
			 first_observed_at, last_observed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		candidate.ID, candidate.HubID, candidate.DeviceRecordKey, candidate.HubAccountKey,
		candidate.RawLimitServiceIdentifier, candidate.NormalizedKind, candidate.NormalizedMetric,
		candidate.OldLabel, candidate.NewLabel, candidate.State, optionalString(candidate.LimitDefinitionID),
		optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt),
		utcText(candidate.CreatedAt), utcText(candidate.UpdatedAt)); err != nil {
		return fmt.Errorf("insert label change candidate: %w", err)
	}
	mutation := catalogMutationForObservation("create", "limit_label_change_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, candidate); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit label change candidate creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) AddLimitLabelChangeWindow(ctx context.Context, window LimitLabelChangeWindow) error {
	if err := window.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin label change window: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO limit_label_change_windows (window_id, candidate_id, window_key, label, observed_at) VALUES (?, ?, ?, ?, ?)`,
		window.ID, window.CandidateID, window.WindowKey, window.Label, catalogPeriodText(window.ObservedAt)); err != nil {
		return fmt.Errorf("insert label change window: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE limit_label_change_candidates SET first_observed_at = CASE WHEN first_observed_at IS NULL OR ? < first_observed_at THEN ? ELSE first_observed_at END, last_observed_at = CASE WHEN last_observed_at IS NULL OR ? > last_observed_at THEN ? ELSE last_observed_at END, updated_at = ? WHERE candidate_id = ?`,
		catalogPeriodText(window.ObservedAt), catalogPeriodText(window.ObservedAt), catalogPeriodText(window.ObservedAt), catalogPeriodText(window.ObservedAt), utcText(window.ObservedAt), window.CandidateID); err != nil {
		return fmt.Errorf("update label change window bounds: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit label change window: %w", err)
	}
	return nil
}

func (l *Lifecycle) DecideLimitLabelChangeCandidate(ctx context.Context, candidateID string, state domain.LabelChangeState, limitDefinitionID string, occurredAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || occurredAt.IsZero() {
		return errors.New("label change decision has an empty required field")
	}
	if state != domain.LabelChangeUnconfirmed && state != domain.LabelChangeSameLimit && state != domain.LabelChangeDifferentLimit && state != domain.LabelChangeRejected {
		return fmt.Errorf("unknown label change state %q", state)
	}
	if state == domain.LabelChangeSameLimit && strings.TrimSpace(limitDefinitionID) == "" {
		return errors.New("same-limit decision requires a limit definition")
	}
	if state != domain.LabelChangeSameLimit && limitDefinitionID != "" {
		return errors.New("only same-limit decision may reference a limit definition")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin label change decision: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before LimitLabelChangeCandidate
	if err := scanLimitLabelChangeCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, hub_id, device_record_key, hub_account_key, raw_limit_service_identifier, normalized_kind, normalized_metric, old_label, new_label, state, limit_definition_id, first_observed_at, last_observed_at, created_at, updated_at FROM limit_label_change_candidates WHERE candidate_id = ?`, candidateID), &before); err != nil {
		return err
	}
	if state == domain.LabelChangeSameLimit {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM limit_definitions WHERE limit_definition_id = ?`, limitDefinitionID).Scan(&count); err != nil {
			return fmt.Errorf("check label change limit definition: %w", err)
		}
		if count != 1 {
			return errors.New("limit definition was not found")
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE limit_label_change_candidates SET state = ?, limit_definition_id = ?, updated_at = ? WHERE candidate_id = ?`,
		state, nullableID(limitDefinitionID), utcText(occurredAt), candidateID); err != nil {
		return fmt.Errorf("decide label change candidate: %w", err)
	}
	after := before
	after.State = state
	after.LimitDefinitionID = nil
	if limitDefinitionID != "" {
		after.LimitDefinitionID = &limitDefinitionID
	}
	after.UpdatedAt = occurredAt
	mutation := catalogMutationForObservation("decide", "limit_label_change_candidate", candidateID, occurredAt, before.FirstObservedAt, before.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit label change decision: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListLimitLabelChangeCandidates(ctx context.Context, state domain.LabelChangeState) ([]LimitLabelChangeCandidate, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT candidate_id, hub_id, device_record_key, hub_account_key, raw_limit_service_identifier, normalized_kind, normalized_metric, old_label, new_label, state, limit_definition_id, first_observed_at, last_observed_at, created_at, updated_at FROM limit_label_change_candidates`
	args := []any{}
	if state != "" {
		query += ` WHERE state = ?`
		args = append(args, state)
	}
	query += ` ORDER BY state, first_observed_at, candidate_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list label change candidates: %w", err)
	}
	defer rows.Close()
	var result []LimitLabelChangeCandidate
	for rows.Next() {
		var candidate LimitLabelChangeCandidate
		if err := scanLimitLabelChangeCandidate(rows, &candidate); err != nil {
			return nil, err
		}
		result = append(result, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read label change candidates: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListLimitLabelChangeWindows(ctx context.Context, candidateID string) ([]LimitLabelChangeWindow, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT window_id, candidate_id, window_key, label, observed_at FROM limit_label_change_windows WHERE candidate_id = ? ORDER BY observed_at, window_id`, candidateID)
	if err != nil {
		return nil, fmt.Errorf("list label change windows: %w", err)
	}
	defer rows.Close()
	var result []LimitLabelChangeWindow
	for rows.Next() {
		var window LimitLabelChangeWindow
		var observed string
		if err := rows.Scan(&window.ID, &window.CandidateID, &window.WindowKey, &window.Label, &observed); err != nil {
			return nil, fmt.Errorf("scan label change window: %w", err)
		}
		window.ObservedAt, err = parseUTC(observed)
		if err != nil {
			return nil, fmt.Errorf("parse label change window time: %w", err)
		}
		result = append(result, window)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read label change windows: %w", err)
	}
	return result, nil
}

func scanLimitLabelChangeCandidate(row interface{ Scan(...any) error }, candidate *LimitLabelChangeCandidate) error {
	var state string
	var limitID sql.NullString
	var first, last, created, updated sql.NullString
	if err := row.Scan(&candidate.ID, &candidate.HubID, &candidate.DeviceRecordKey, &candidate.HubAccountKey,
		&candidate.RawLimitServiceIdentifier, &candidate.NormalizedKind, &candidate.NormalizedMetric,
		&candidate.OldLabel, &candidate.NewLabel, &state, &limitID, &first, &last, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("label change candidate was not found")
		}
		return fmt.Errorf("scan label change candidate: %w", err)
	}
	candidate.State = domain.LabelChangeState(state)
	if limitID.Valid {
		candidate.LimitDefinitionID = &limitID.String
	}
	if first.Valid {
		value, err := parseUTC(first.String)
		if err != nil {
			return fmt.Errorf("parse label change first time: %w", err)
		}
		candidate.FirstObservedAt = &value
	}
	if last.Valid {
		value, err := parseUTC(last.String)
		if err != nil {
			return fmt.Errorf("parse label change last time: %w", err)
		}
		candidate.LastObservedAt = &value
	}
	var err error
	candidate.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse label change creation time: %w", err)
	}
	candidate.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse label change update time: %w", err)
	}
	return nil
}

func nullableID(value string) any {
	if value == "" {
		return nil
	}
	return value
}
