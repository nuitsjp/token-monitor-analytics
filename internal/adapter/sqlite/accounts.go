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

type HubAccountCandidate = domain.HubAccountCandidate
type HubAccount = domain.HubAccountCandidate
type LogicalAccount = domain.LogicalAccount
type PlanHistory = domain.PlanHistory

var (
	ErrHubAccountCandidateRequiresKey = errors.New("Hub account candidate requires a non-empty account key")
	ErrHubAccountCandidateNotFound    = errors.New("Hub account candidate was not found")
	ErrLogicalAccountNotFound         = errors.New("logical account was not found")
	ErrPlanHistoryNotFound            = errors.New("plan history was not found")
)

// CreateHubAccountCandidate persists one observation-side account candidate.
// Callers must provide an accountKey; display information is never used as an
// identity fallback.
func (l *Lifecycle) CreateHubAccountCandidate(ctx context.Context, candidate HubAccountCandidate) error {
	if err := validateHubAccountCandidate(candidate); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub account candidate creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertHubAccountCandidateTx(ctx, tx, candidate); err != nil {
		return err
	}
	mutation := accountMutation("create", "hub_account_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, candidateAuditValue(candidate)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub account candidate creation: %w", err)
	}
	return nil
}

// CreateHubAccount is the shorter vocabulary alias for
// CreateHubAccountCandidate.
func (l *Lifecycle) CreateHubAccount(ctx context.Context, candidate HubAccount) error {
	return l.CreateHubAccountCandidate(ctx, candidate)
}

// UpsertHubAccountCandidate updates non-secret display evidence and observed
// bounds for an existing Hub/service/accountKey. It does not auto-associate an
// unconfirmed candidate. A new observation for an archived logical account is
// marked for explicit reconfirmation instead of restoring that account.
func (l *Lifecycle) UpsertHubAccountCandidate(ctx context.Context, candidate HubAccountCandidate) error {
	if err := validateHubAccountCandidate(candidate); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub account candidate upsert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := upsertHubAccountCandidateTx(ctx, tx, candidate); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub account candidate upsert: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpsertHubAccount(ctx context.Context, candidate HubAccount) error {
	return l.UpsertHubAccountCandidate(ctx, candidate)
}

func (l *Lifecycle) ListHubAccountCandidates(ctx context.Context, serviceID string, state domain.HubAccountCandidateState) ([]HubAccountCandidate, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT hub_account_candidate_id, hub_id, service_id, account_key, display_name, email,
		workspace_name, device_name, state, logical_account_id, first_observed_at, last_observed_at,
		created_at, updated_at FROM hub_account_candidates WHERE 1 = 1`
	args := make([]any, 0, 2)
	if serviceID != "" {
		query += ` AND service_id = ?`
		args = append(args, serviceID)
	}
	if state != "" {
		query += ` AND state = ?`
		args = append(args, state)
	}
	query += ` ORDER BY service_id, hub_id, account_key, hub_account_candidate_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list Hub account candidates: %w", err)
	}
	defer rows.Close()
	result := make([]HubAccountCandidate, 0)
	for rows.Next() {
		var candidate HubAccountCandidate
		if err := scanHubAccountCandidate(rows, &candidate); err != nil {
			return nil, err
		}
		result = append(result, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Hub account candidates: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListHubAccounts(ctx context.Context, serviceID string, state domain.HubAccountCandidateState) ([]HubAccount, error) {
	return l.ListHubAccountCandidates(ctx, serviceID, state)
}

func (l *Lifecycle) CreateLogicalAccount(ctx context.Context, account LogicalAccount) error {
	if err := account.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertLogicalAccountTx(ctx, tx, account); err != nil {
		return err
	}
	mutation := accountMutation("create", "logical_account", account.ID, account.UpdatedAt, nil, nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, accountAuditValue(account)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateLogicalAccount(ctx context.Context, account LogicalAccount) error {
	if err := account.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before LogicalAccount
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, account.ID), &before); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read logical account before update: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE logical_accounts SET service_id = ?, display_name = ?, archived_at = ?, updated_at = ? WHERE logical_account_id = ?`, account.ServiceID, account.DisplayName, optionalTimeText(account.ArchivedAt), utcText(account.UpdatedAt), account.ID); err != nil {
		return fmt.Errorf("update logical account: %w", err)
	}
	mutation := accountMutation("update", "logical_account", account.ID, account.UpdatedAt, nil, nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, accountAuditValue(before), accountAuditValue(account)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ArchiveLogicalAccount(ctx context.Context, accountID string, archivedAt time.Time) error {
	return l.setLogicalAccountArchive(ctx, accountID, &archivedAt, archivedAt, "archive")
}

func (l *Lifecycle) RestoreLogicalAccount(ctx context.Context, accountID string, restoredAt time.Time) error {
	return l.setLogicalAccountArchive(ctx, accountID, nil, restoredAt, "restore")
}

func (l *Lifecycle) setLogicalAccountArchive(ctx context.Context, accountID string, archivedAt *time.Time, changedAt time.Time, action string) error {
	if strings.TrimSpace(accountID) == "" || changedAt.IsZero() {
		return errors.New("logical account archive has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account %s: %w", action, err)
	}
	defer func() { _ = tx.Rollback() }()
	var before LogicalAccount
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, accountID), &before); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read logical account before %s: %w", action, err)
	}
	after := before
	after.ArchivedAt = normalizedTimePtr(archivedAt)
	after.UpdatedAt = changedAt.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE logical_accounts SET archived_at = ?, updated_at = ? WHERE logical_account_id = ?`, optionalTimeText(after.ArchivedAt), utcText(after.UpdatedAt), accountID); err != nil {
		return fmt.Errorf("%s logical account: %w", action, err)
	}
	mutation := accountMutation(action, "logical_account", accountID, changedAt, nil, nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, accountAuditValue(before), accountAuditValue(after)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account %s: %w", action, err)
	}
	return nil
}

func (l *Lifecycle) ListLogicalAccounts(ctx context.Context, serviceID string, includeArchived bool) ([]LogicalAccount, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE 1 = 1`
	args := make([]any, 0, 1)
	if serviceID != "" {
		query += ` AND service_id = ?`
		args = append(args, serviceID)
	}
	if !includeArchived {
		query += ` AND archived_at IS NULL`
	}
	query += ` ORDER BY service_id, display_name, logical_account_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list logical accounts: %w", err)
	}
	defer rows.Close()
	result := make([]LogicalAccount, 0)
	for rows.Next() {
		var account LogicalAccount
		if err := scanLogicalAccount(rows, &account); err != nil {
			return nil, err
		}
		result = append(result, account)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read logical accounts: %w", err)
	}
	return result, nil
}

// CreateLogicalAccountFromHubAccountCandidate creates a logical account and
// associates the candidate in one SQLite transaction. No display-only value
// can reach this method without an existing non-empty accountKey candidate.
func (l *Lifecycle) CreateLogicalAccountFromHubAccountCandidate(ctx context.Context, candidateID string, account LogicalAccount) error {
	if err := account.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(candidateID) == "" {
		return ErrHubAccountCandidateNotFound
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account creation from candidate: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var candidate HubAccountCandidate
	if err := scanHubAccountCandidate(tx.QueryRowContext(ctx, `SELECT hub_account_candidate_id, hub_id, service_id, account_key, display_name, email, workspace_name, device_name, state, logical_account_id, first_observed_at, last_observed_at, created_at, updated_at FROM hub_account_candidates WHERE hub_account_candidate_id = ?`, candidateID), &candidate); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrHubAccountCandidateNotFound
		}
		return fmt.Errorf("read Hub account candidate: %w", err)
	}
	if candidate.State == domain.HubAccountCandidateAssociated || candidate.State == domain.HubAccountCandidateArchivedReconfirmation {
		return errors.New("Hub account candidate is already associated")
	}
	if candidate.ServiceID != account.ServiceID {
		return errors.New("Hub account candidate and logical account belong to different services")
	}
	if err := insertLogicalAccountTx(ctx, tx, account); err != nil {
		return err
	}
	state := domain.HubAccountCandidateAssociated
	if account.ArchivedAt != nil {
		state = domain.HubAccountCandidateArchivedReconfirmation
	}
	afterCandidate := candidate
	afterCandidate.State = state
	afterCandidate.LogicalAccountID = stringPtr(account.ID)
	afterCandidate.UpdatedAt = account.UpdatedAt.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET state = ?, logical_account_id = ?, updated_at = ? WHERE hub_account_candidate_id = ?`, state, account.ID, utcText(afterCandidate.UpdatedAt), candidateID); err != nil {
		return fmt.Errorf("associate Hub account candidate: %w", err)
	}
	mutation := accountMutation("create_from_candidate", "logical_account", account.ID, account.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation,
		map[string]any{"candidate": candidateAuditValue(candidate)},
		map[string]any{"logical_account": accountAuditValue(account), "candidate": candidateAuditValue(afterCandidate)}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account creation from candidate: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateLogicalAccountFromCandidate(ctx context.Context, candidateID string, account LogicalAccount) error {
	return l.CreateLogicalAccountFromHubAccountCandidate(ctx, candidateID, account)
}

func (l *Lifecycle) AssociateHubAccountCandidate(ctx context.Context, candidateID, logicalAccountID string, associatedAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" {
		return ErrHubAccountCandidateNotFound
	}
	if strings.TrimSpace(logicalAccountID) == "" || associatedAt.IsZero() {
		return errors.New("Hub account association has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub account association: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var candidate HubAccountCandidate
	if err := scanHubAccountCandidate(tx.QueryRowContext(ctx, `SELECT hub_account_candidate_id, hub_id, service_id, account_key, display_name, email, workspace_name, device_name, state, logical_account_id, first_observed_at, last_observed_at, created_at, updated_at FROM hub_account_candidates WHERE hub_account_candidate_id = ?`, candidateID), &candidate); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrHubAccountCandidateNotFound
		}
		return fmt.Errorf("read Hub account candidate for association: %w", err)
	}
	var account LogicalAccount
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, logicalAccountID), &account); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read logical account for association: %w", err)
	}
	if candidate.ServiceID != account.ServiceID {
		return errors.New("Hub account candidate and logical account belong to different services")
	}
	state := domain.HubAccountCandidateAssociated
	if account.ArchivedAt != nil {
		state = domain.HubAccountCandidateArchivedReconfirmation
	}
	after := candidate
	after.State = state
	after.LogicalAccountID = stringPtr(logicalAccountID)
	after.UpdatedAt = associatedAt.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET state = ?, logical_account_id = ?, updated_at = ? WHERE hub_account_candidate_id = ?`, state, logicalAccountID, utcText(after.UpdatedAt), candidateID); err != nil {
		return fmt.Errorf("associate Hub account candidate: %w", err)
	}
	mutation := accountMutation("associate", "hub_account_candidate", candidateID, associatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, candidateAuditValue(candidate), candidateAuditValue(after)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub account association: %w", err)
	}
	return nil
}

func (l *Lifecycle) AssociateHubAccount(ctx context.Context, candidateID, logicalAccountID string, associatedAt time.Time) error {
	return l.AssociateHubAccountCandidate(ctx, candidateID, logicalAccountID, associatedAt)
}

// SetHubAccountCandidateState is the explicit candidate decision operation.
// Rejected/unconfirmed candidates cannot retain a logical account reference.
func (l *Lifecycle) SetHubAccountCandidateState(ctx context.Context, candidateID string, state domain.HubAccountCandidateState, changedAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || changedAt.IsZero() {
		return errors.New("Hub account candidate state has an empty required field")
	}
	if state != domain.HubAccountCandidateUnconfirmed && state != domain.HubAccountCandidateRejected {
		return errors.New("candidate association states require an explicit logical account")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub account candidate state change: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before HubAccountCandidate
	if err := scanHubAccountCandidate(tx.QueryRowContext(ctx, `SELECT hub_account_candidate_id, hub_id, service_id, account_key, display_name, email, workspace_name, device_name, state, logical_account_id, first_observed_at, last_observed_at, created_at, updated_at FROM hub_account_candidates WHERE hub_account_candidate_id = ?`, candidateID), &before); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrHubAccountCandidateNotFound
		}
		return err
	}
	after := before
	after.State = state
	after.LogicalAccountID = nil
	after.UpdatedAt = changedAt.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET state = ?, logical_account_id = NULL, updated_at = ? WHERE hub_account_candidate_id = ?`, state, utcText(after.UpdatedAt), candidateID); err != nil {
		return fmt.Errorf("set Hub account candidate state: %w", err)
	}
	mutation := accountMutation(string(state), "hub_account_candidate", candidateID, changedAt, before.FirstObservedAt, before.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, candidateAuditValue(before), candidateAuditValue(after)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub account candidate state: %w", err)
	}
	return nil
}

// SplitLogicalAccount creates a new logical account and moves selected Hub
// account candidates from the source. Source plan history is retained as
// historical evidence; the new account starts with no inferred plan history.
func (l *Lifecycle) SplitLogicalAccount(ctx context.Context, sourceID string, newAccount LogicalAccount, candidateIDs ...string) error {
	if err := newAccount.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(sourceID) == "" || len(candidateIDs) == 0 {
		return errors.New("logical account split requires a source and at least one candidate")
	}
	if duplicateStrings(candidateIDs) {
		return errors.New("logical account split contains a duplicate candidate")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account split: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var source LogicalAccount
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, sourceID), &source); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read source logical account: %w", err)
	}
	if newAccount.ServiceID != source.ServiceID {
		return errors.New("split logical account must use the source service")
	}
	if err := insertLogicalAccountTx(ctx, tx, newAccount); err != nil {
		return err
	}
	for _, candidateID := range candidateIDs {
		var owner, candidateService string
		if err := tx.QueryRowContext(ctx, `SELECT service_id, logical_account_id FROM hub_account_candidates WHERE hub_account_candidate_id = ?`, candidateID).Scan(&candidateService, &owner); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrHubAccountCandidateNotFound
			}
			return fmt.Errorf("read split Hub account candidate: %w", err)
		}
		if candidateService != source.ServiceID || owner != sourceID {
			return errors.New("split candidate is not associated with the source logical account")
		}
		state := domain.HubAccountCandidateAssociated
		if newAccount.ArchivedAt != nil {
			state = domain.HubAccountCandidateArchivedReconfirmation
		}
		if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET logical_account_id = ?, state = ?, updated_at = ? WHERE hub_account_candidate_id = ?`, newAccount.ID, state, utcText(newAccount.UpdatedAt), candidateID); err != nil {
			return fmt.Errorf("move split Hub account candidate: %w", err)
		}
	}
	mutation := accountMutation("split", "logical_account", newAccount.ID, newAccount.UpdatedAt, nil, nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation,
		map[string]any{"source_logical_account_id": sourceID, "moved_candidate_ids": candidateIDs},
		map[string]any{"new_logical_account": accountAuditValue(newAccount), "moved_candidate_ids": candidateIDs}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account split: %w", err)
	}
	return nil
}

// MergeLogicalAccounts moves the source's Hub account candidates to target and
// archives the source. Source plan history remains attached to the archived
// account so the historical record is not rewritten.
func (l *Lifecycle) MergeLogicalAccounts(ctx context.Context, sourceID, targetID string, mergedAt time.Time) error {
	if strings.TrimSpace(sourceID) == "" || strings.TrimSpace(targetID) == "" || sourceID == targetID || mergedAt.IsZero() {
		return errors.New("logical account merge has an invalid required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin logical account merge: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var source, target LogicalAccount
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, sourceID), &source); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read source logical account for merge: %w", err)
	}
	if err := scanLogicalAccount(tx.QueryRowContext(ctx, `SELECT logical_account_id, service_id, display_name, archived_at, created_at, updated_at FROM logical_accounts WHERE logical_account_id = ?`, targetID), &target); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrLogicalAccountNotFound
		}
		return fmt.Errorf("read target logical account for merge: %w", err)
	}
	if source.ServiceID != target.ServiceID {
		return errors.New("logical accounts from different services cannot be merged")
	}
	state := domain.HubAccountCandidateAssociated
	if target.ArchivedAt != nil {
		state = domain.HubAccountCandidateArchivedReconfirmation
	}
	if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET logical_account_id = ?, state = ?, updated_at = ? WHERE logical_account_id = ?`, targetID, state, utcText(mergedAt), sourceID); err != nil {
		return fmt.Errorf("move merged Hub account candidates: %w", err)
	}
	archived := mergedAt.UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE logical_accounts SET archived_at = ?, updated_at = ? WHERE logical_account_id = ?`, utcText(archived), utcText(mergedAt), sourceID); err != nil {
		return fmt.Errorf("archive merged source logical account: %w", err)
	}
	afterSource := source
	afterSource.ArchivedAt = &archived
	afterSource.UpdatedAt = mergedAt.UTC()
	mutation := accountMutation("merge", "logical_account", sourceID, mergedAt, nil, nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation,
		map[string]any{"source_logical_account": accountAuditValue(source), "target_logical_account_id": targetID},
		map[string]any{"source_logical_account": accountAuditValue(afterSource), "target_logical_account": accountAuditValue(target)}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit logical account merge: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreatePlanHistory(ctx context.Context, history PlanHistory) error {
	if err := normalizePlanHistory(&history); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan history creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertPlanHistoryTx(ctx, tx, history); err != nil {
		return err
	}
	mutation := accountMutation("create", "plan_history", history.ID, history.UpdatedAt, &history.ValidFrom, history.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, historyAuditValue(history)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan history creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdatePlanHistory(ctx context.Context, history PlanHistory) error {
	if err := normalizePlanHistory(&history); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan history update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before PlanHistory
	if err := scanPlanHistory(tx.QueryRowContext(ctx, `SELECT plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at FROM plan_histories WHERE plan_history_id = ?`, history.ID), &before); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrPlanHistoryNotFound
		}
		return fmt.Errorf("read plan history before update: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE plan_histories SET logical_account_id = ?, plan_version_id = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE plan_history_id = ?`, history.LogicalAccountID, history.PlanVersionID, catalogPeriodText(history.ValidFrom), optionalCatalogPeriodText(history.ValidTo), utcText(history.UpdatedAt), history.ID); err != nil {
		return fmt.Errorf("update plan history: %w", err)
	}
	mutation := accountMutation("update", "plan_history", history.ID, history.UpdatedAt, &history.ValidFrom, history.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, historyAuditValue(before), historyAuditValue(history)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan history update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListPlanHistories(ctx context.Context, logicalAccountID string) ([]PlanHistory, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at FROM plan_histories`
	args := make([]any, 0, 1)
	if logicalAccountID != "" {
		query += ` WHERE logical_account_id = ?`
		args = append(args, logicalAccountID)
	}
	query += ` ORDER BY logical_account_id, valid_from, plan_history_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list plan histories: %w", err)
	}
	defer rows.Close()
	result := make([]PlanHistory, 0)
	for rows.Next() {
		var history PlanHistory
		if err := scanPlanHistory(rows, &history); err != nil {
			return nil, err
		}
		result = append(result, history)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read plan histories: %w", err)
	}
	return result, nil
}

func validateHubAccountCandidate(candidate HubAccountCandidate) error {
	if strings.TrimSpace(candidate.AccountKey) == "" {
		return ErrHubAccountCandidateRequiresKey
	}
	if candidate.State == "" {
		candidate.State = domain.HubAccountCandidateUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	return nil
}

func insertHubAccountCandidateTx(ctx context.Context, tx *sql.Tx, candidate HubAccountCandidate) error {
	state := candidate.State
	if state == "" {
		state = domain.HubAccountCandidateUnconfirmed
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO hub_account_candidates
			(hub_account_candidate_id, hub_id, service_id, account_key, display_name, email, workspace_name, device_name,
			 state, logical_account_id, first_observed_at, last_observed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		candidate.ID, candidate.HubID, candidate.ServiceID, candidate.AccountKey, candidate.DisplayName, candidate.Email,
		candidate.WorkspaceName, candidate.DeviceName, state, optionalID(candidate.LogicalAccountID),
		optionalPeriodText(candidate.FirstObservedAt), optionalPeriodText(candidate.LastObservedAt), utcText(candidate.CreatedAt), utcText(candidate.UpdatedAt)); err != nil {
		return fmt.Errorf("insert Hub account candidate: %w", err)
	}
	return nil
}

// upsertHubAccountCandidateTx is shared by explicit M05 edits and the
// collection transaction. It deliberately keeps the observation-side key
// separate from logical-account association and preserves archived
// reconfirmation state.
func upsertHubAccountCandidateTx(ctx context.Context, tx *sql.Tx, candidate HubAccountCandidate) error {
	var existing HubAccountCandidate
	err := scanHubAccountCandidate(tx.QueryRowContext(ctx, `
		SELECT hub_account_candidate_id, hub_id, service_id, account_key, display_name, email,
			workspace_name, device_name, state, logical_account_id, first_observed_at,
			last_observed_at, created_at, updated_at
		FROM hub_account_candidates WHERE hub_id = ? AND service_id = ? AND account_key = ?`,
		candidate.HubID, candidate.ServiceID, candidate.AccountKey), &existing)
	if errors.Is(err, sql.ErrNoRows) {
		if err := insertHubAccountCandidateTx(ctx, tx, candidate); err != nil {
			return err
		}
		mutation := accountMutation("create", "hub_account_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
		return appendCatalogAuditAndRequest(ctx, tx, mutation, nil, candidateAuditValue(candidate))
	}
	if err != nil {
		return fmt.Errorf("read Hub account candidate for transaction upsert: %w", err)
	}
	before := existing
	merged := mergeHubAccountCandidate(existing, candidate)
	if archived, err := logicalAccountArchivedTx(ctx, tx, existing.LogicalAccountID); err != nil {
		return err
	} else if archived && existing.LogicalAccountID != nil {
		merged.State = domain.HubAccountCandidateArchivedReconfirmation
		merged.LogicalAccountID = existing.LogicalAccountID
	}
	if err := merged.Validate(); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE hub_account_candidates SET display_name = ?, email = ?, workspace_name = ?, device_name = ?,
			state = ?, logical_account_id = ?, first_observed_at = ?, last_observed_at = ?, updated_at = ?
		WHERE hub_account_candidate_id = ?`,
		merged.DisplayName, merged.Email, merged.WorkspaceName, merged.DeviceName, merged.State,
		optionalID(merged.LogicalAccountID), optionalPeriodText(merged.FirstObservedAt), optionalPeriodText(merged.LastObservedAt),
		utcText(merged.UpdatedAt), merged.ID); err != nil {
		return fmt.Errorf("update Hub account candidate in transaction upsert: %w", err)
	}
	mutation := accountMutation("update", "hub_account_candidate", merged.ID, merged.UpdatedAt, merged.FirstObservedAt, merged.LastObservedAt)
	return appendCatalogAuditAndRequest(ctx, tx, mutation, candidateAuditValue(before), candidateAuditValue(merged))
}

func insertLogicalAccountTx(ctx context.Context, tx *sql.Tx, account LogicalAccount) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO logical_accounts (logical_account_id, service_id, display_name, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, account.ID, account.ServiceID, account.DisplayName, optionalTimeText(account.ArchivedAt), utcText(account.CreatedAt), utcText(account.UpdatedAt)); err != nil {
		return fmt.Errorf("insert logical account: %w", err)
	}
	return nil
}

func insertPlanHistoryTx(ctx context.Context, tx *sql.Tx, history PlanHistory) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, history.ID, history.LogicalAccountID, history.PlanVersionID, catalogPeriodText(history.ValidFrom), optionalCatalogPeriodText(history.ValidTo), utcText(history.CreatedAt), utcText(history.UpdatedAt)); err != nil {
		return fmt.Errorf("insert plan history: %w", err)
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanHubAccountCandidate(row rowScanner, candidate *HubAccountCandidate) error {
	var state string
	var logicalID, first, last, created, updated sql.NullString
	if err := row.Scan(&candidate.ID, &candidate.HubID, &candidate.ServiceID, &candidate.AccountKey, &candidate.DisplayName, &candidate.Email,
		&candidate.WorkspaceName, &candidate.DeviceName, &state, &logicalID, &first, &last, &created, &updated); err != nil {
		return fmt.Errorf("scan Hub account candidate: %w", err)
	}
	candidate.State = domain.HubAccountCandidateState(state)
	if logicalID.Valid {
		candidate.LogicalAccountID = stringPtr(logicalID.String)
	}
	var err error
	candidate.FirstObservedAt, err = parseOptionalPeriod(first)
	if err != nil {
		return fmt.Errorf("parse Hub account candidate first observation: %w", err)
	}
	candidate.LastObservedAt, err = parseOptionalPeriod(last)
	if err != nil {
		return fmt.Errorf("parse Hub account candidate last observation: %w", err)
	}
	candidate.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse Hub account candidate creation time: %w", err)
	}
	candidate.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse Hub account candidate update time: %w", err)
	}
	return nil
}

func scanLogicalAccount(row rowScanner, account *LogicalAccount) error {
	var archived, created, updated sql.NullString
	if err := row.Scan(&account.ID, &account.ServiceID, &account.DisplayName, &archived, &created, &updated); err != nil {
		return fmt.Errorf("scan logical account: %w", err)
	}
	var err error
	if archived.Valid {
		value, parseErr := parseUTC(archived.String)
		if parseErr != nil {
			return fmt.Errorf("parse logical account archive time: %w", parseErr)
		}
		account.ArchivedAt = &value
	}
	account.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse logical account creation time: %w", err)
	}
	account.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse logical account update time: %w", err)
	}
	return nil
}

func scanPlanHistory(row rowScanner, history *PlanHistory) error {
	var from, to, created, updated string
	var nullableTo sql.NullString
	if err := row.Scan(&history.ID, &history.LogicalAccountID, &history.PlanVersionID, &from, &nullableTo, &created, &updated); err != nil {
		return fmt.Errorf("scan plan history: %w", err)
	}
	var err error
	history.ValidFrom, err = parseUTC(from)
	if err != nil {
		return fmt.Errorf("parse plan history start: %w", err)
	}
	if nullableTo.Valid {
		to = nullableTo.String
		var parsedTo time.Time
		parsedTo, err = parseUTC(to)
		if err != nil {
			return fmt.Errorf("parse plan history end: %w", err)
		}
		history.ValidTo = &parsedTo
	}
	history.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse plan history creation time: %w", err)
	}
	history.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return fmt.Errorf("parse plan history update time: %w", err)
	}
	return nil
}

func mergeHubAccountCandidate(existing, incoming HubAccountCandidate) HubAccountCandidate {
	merged := existing
	merged.DisplayName = incoming.DisplayName
	merged.Email = incoming.Email
	merged.WorkspaceName = incoming.WorkspaceName
	merged.DeviceName = incoming.DeviceName
	merged.UpdatedAt = incoming.UpdatedAt.UTC()
	if incoming.FirstObservedAt != nil && (merged.FirstObservedAt == nil || incoming.FirstObservedAt.Before(*merged.FirstObservedAt)) {
		merged.FirstObservedAt = normalizedTimePtr(incoming.FirstObservedAt)
	}
	if incoming.LastObservedAt != nil && (merged.LastObservedAt == nil || merged.LastObservedAt.Before(*incoming.LastObservedAt)) {
		merged.LastObservedAt = normalizedTimePtr(incoming.LastObservedAt)
	}
	return merged
}

func normalizePlanHistory(history *PlanHistory) error {
	history.ValidFrom = history.ValidFrom.UTC()
	if history.ValidTo != nil {
		value := history.ValidTo.UTC()
		history.ValidTo = &value
	}
	history.CreatedAt = history.CreatedAt.UTC()
	history.UpdatedAt = history.UpdatedAt.UTC()
	return history.Validate()
}

func accountMutation(action, entityType, entityID string, occurredAt time.Time, first, last *time.Time) CatalogMutation {
	if first != nil {
		return catalogMutationForObservation(action, entityType, entityID, occurredAt, normalizedTimePtr(first), normalizedTimePtr(last))
	}
	return defaultCatalogMutation(action, entityType, entityID, occurredAt.UTC())
}

func logicalAccountArchivedTx(ctx context.Context, tx *sql.Tx, accountID *string) (bool, error) {
	if accountID == nil || strings.TrimSpace(*accountID) == "" {
		return false, nil
	}
	var archived sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT archived_at FROM logical_accounts WHERE logical_account_id = ?`, *accountID).Scan(&archived); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, ErrLogicalAccountNotFound
		}
		return false, fmt.Errorf("read logical account archive state: %w", err)
	}
	return archived.Valid, nil
}

func candidateAuditValue(candidate HubAccountCandidate) map[string]any {
	return map[string]any{
		"id": candidate.ID, "hub_id": candidate.HubID, "service_id": candidate.ServiceID,
		"account_key": candidate.AccountKey, "display_name": candidate.DisplayName, "email": candidate.Email,
		"workspace_name": candidate.WorkspaceName, "device_name": candidate.DeviceName, "state": candidate.State,
		"logical_account_id": optionalID(candidate.LogicalAccountID), "first_observed_at": optionalAuditTime(candidate.FirstObservedAt),
		"last_observed_at": optionalAuditTime(candidate.LastObservedAt),
	}
}

func accountAuditValue(account LogicalAccount) map[string]any {
	return map[string]any{"id": account.ID, "service_id": account.ServiceID, "display_name": account.DisplayName, "archived_at": optionalAuditTime(account.ArchivedAt)}
}

func historyAuditValue(history PlanHistory) map[string]any {
	return map[string]any{"id": history.ID, "logical_account_id": history.LogicalAccountID, "plan_version_id": history.PlanVersionID, "valid_from": history.ValidFrom.UTC().Format(time.RFC3339Nano), "valid_to": optionalAuditTime(history.ValidTo)}
}

func optionalID(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return *value
}

func optionalPeriodText(value *time.Time) any {
	if value == nil {
		return nil
	}
	return catalogPeriodText(value.UTC())
}

func parseOptionalPeriod(value sql.NullString) (*time.Time, error) {
	if !value.Valid || value.String == "" {
		return nil, nil
	}
	parsed, err := parseUTC(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func normalizedTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := value.UTC()
	return &result
}

func optionalAuditTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func stringPtr(value string) *string { return &value }

func duplicateStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}
