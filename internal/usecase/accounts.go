package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

// AccountStore is the narrow account/plan-history port. The SQLite adapter
// owns each transaction, configuration audit, and recalculation request.
type AccountStore interface {
	CreateHubAccountCandidate(context.Context, domain.HubAccountCandidate) error
	UpsertHubAccountCandidate(context.Context, domain.HubAccountCandidate) error
	CreateLogicalAccount(context.Context, domain.LogicalAccount) error
	UpdateLogicalAccount(context.Context, domain.LogicalAccount) error
	ArchiveLogicalAccount(context.Context, string, time.Time) error
	RestoreLogicalAccount(context.Context, string, time.Time) error
	CreateLogicalAccountFromHubAccountCandidate(context.Context, string, domain.LogicalAccount) error
	AssociateHubAccountCandidate(context.Context, string, string, time.Time) error
	SetHubAccountCandidateState(context.Context, string, domain.HubAccountCandidateState, time.Time) error
	SplitLogicalAccount(context.Context, string, domain.LogicalAccount, ...string) error
	MergeLogicalAccounts(context.Context, string, string, time.Time) error
	CreatePlanHistory(context.Context, domain.PlanHistory) error
	UpdatePlanHistory(context.Context, domain.PlanHistory) error
}

type AccountUsecase struct {
	store AccountStore
	clock Clock
	ids   IDGenerator
}

func NewAccountUsecase(store AccountStore, clock Clock, ids IDGenerator) (*AccountUsecase, error) {
	if store == nil || clock == nil || ids == nil {
		return nil, errors.New("account usecase dependencies are required")
	}
	return &AccountUsecase{store: store, clock: clock, ids: ids}, nil
}

func (u *AccountUsecase) RegisterHubAccountCandidate(ctx context.Context, candidate domain.HubAccountCandidate) (domain.HubAccountCandidate, error) {
	if candidate.ID == "" {
		candidate.ID = u.ids.New()
	}
	now := u.clock.Now().UTC()
	if candidate.CreatedAt.IsZero() {
		candidate.CreatedAt = now
	}
	if candidate.UpdatedAt.IsZero() {
		candidate.UpdatedAt = now
	}
	if candidate.State == "" {
		candidate.State = domain.HubAccountCandidateUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return domain.HubAccountCandidate{}, err
	}
	if err := u.store.CreateHubAccountCandidate(ctx, candidate); err != nil {
		return domain.HubAccountCandidate{}, fmt.Errorf("register Hub account candidate: %w", err)
	}
	return candidate, nil
}

func (u *AccountUsecase) ObserveHubAccountCandidate(ctx context.Context, candidate domain.HubAccountCandidate) error {
	if candidate.ID == "" {
		candidate.ID = u.ids.New()
	}
	now := u.clock.Now().UTC()
	if candidate.CreatedAt.IsZero() {
		candidate.CreatedAt = now
	}
	if candidate.UpdatedAt.IsZero() {
		candidate.UpdatedAt = now
	}
	if candidate.State == "" {
		candidate.State = domain.HubAccountCandidateUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	if err := u.store.UpsertHubAccountCandidate(ctx, candidate); err != nil {
		return fmt.Errorf("observe Hub account candidate: %w", err)
	}
	return nil
}

func (u *AccountUsecase) RegisterLogicalAccount(ctx context.Context, serviceID, displayName string) (domain.LogicalAccount, error) {
	now := u.clock.Now().UTC()
	account := domain.LogicalAccount{ID: u.ids.New(), ServiceID: serviceID, DisplayName: displayName, CreatedAt: now, UpdatedAt: now}
	if err := account.Validate(); err != nil {
		return domain.LogicalAccount{}, err
	}
	if err := u.store.CreateLogicalAccount(ctx, account); err != nil {
		return domain.LogicalAccount{}, fmt.Errorf("register logical account: %w", err)
	}
	return account, nil
}

// CreateLogicalAccountFromCandidate is explicit: the caller supplies the
// service and display name, while the repository verifies the candidate's
// non-empty accountKey and service relation in the same transaction.
func (u *AccountUsecase) CreateLogicalAccountFromCandidate(ctx context.Context, candidateID, serviceID, displayName string) (domain.LogicalAccount, error) {
	now := u.clock.Now().UTC()
	account := domain.LogicalAccount{ID: u.ids.New(), ServiceID: serviceID, DisplayName: displayName, CreatedAt: now, UpdatedAt: now}
	if err := account.Validate(); err != nil {
		return domain.LogicalAccount{}, err
	}
	if err := u.store.CreateLogicalAccountFromHubAccountCandidate(ctx, candidateID, account); err != nil {
		return domain.LogicalAccount{}, fmt.Errorf("create logical account from candidate: %w", err)
	}
	return account, nil
}

func (u *AccountUsecase) AssociateHubAccountCandidate(ctx context.Context, candidateID, logicalAccountID string) error {
	if err := u.store.AssociateHubAccountCandidate(ctx, candidateID, logicalAccountID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("associate Hub account candidate: %w", err)
	}
	return nil
}

func (u *AccountUsecase) RejectHubAccountCandidate(ctx context.Context, candidateID string) error {
	if err := u.store.SetHubAccountCandidateState(ctx, candidateID, domain.HubAccountCandidateRejected, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("reject Hub account candidate: %w", err)
	}
	return nil
}

func (u *AccountUsecase) ReleaseHubAccountCandidate(ctx context.Context, candidateID string) error {
	if err := u.store.SetHubAccountCandidateState(ctx, candidateID, domain.HubAccountCandidateUnconfirmed, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("release Hub account candidate: %w", err)
	}
	return nil
}

func (u *AccountUsecase) UpdateLogicalAccount(ctx context.Context, account domain.LogicalAccount) error {
	if account.UpdatedAt.IsZero() {
		account.UpdatedAt = u.clock.Now().UTC()
	}
	if err := account.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdateLogicalAccount(ctx, account); err != nil {
		return fmt.Errorf("update logical account: %w", err)
	}
	return nil
}

func (u *AccountUsecase) ArchiveLogicalAccount(ctx context.Context, accountID string) error {
	if err := u.store.ArchiveLogicalAccount(ctx, accountID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("archive logical account: %w", err)
	}
	return nil
}

func (u *AccountUsecase) RestoreLogicalAccount(ctx context.Context, accountID string) error {
	if err := u.store.RestoreLogicalAccount(ctx, accountID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("restore logical account: %w", err)
	}
	return nil
}

func (u *AccountUsecase) SplitLogicalAccount(ctx context.Context, sourceID, serviceID, displayName string, candidateIDs ...string) (domain.LogicalAccount, error) {
	now := u.clock.Now().UTC()
	account := domain.LogicalAccount{ID: u.ids.New(), ServiceID: serviceID, DisplayName: displayName, CreatedAt: now, UpdatedAt: now}
	if err := account.Validate(); err != nil {
		return domain.LogicalAccount{}, err
	}
	if err := u.store.SplitLogicalAccount(ctx, sourceID, account, candidateIDs...); err != nil {
		return domain.LogicalAccount{}, fmt.Errorf("split logical account: %w", err)
	}
	return account, nil
}

func (u *AccountUsecase) MergeLogicalAccounts(ctx context.Context, sourceID, targetID string) error {
	if err := u.store.MergeLogicalAccounts(ctx, sourceID, targetID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("merge logical accounts: %w", err)
	}
	return nil
}

func (u *AccountUsecase) RegisterPlanHistory(ctx context.Context, logicalAccountID, planVersionID string, validFrom time.Time, validTo *time.Time) (domain.PlanHistory, error) {
	now := u.clock.Now().UTC()
	history := domain.PlanHistory{ID: u.ids.New(), LogicalAccountID: logicalAccountID, PlanVersionID: planVersionID, ValidFrom: validFrom.UTC(), ValidTo: normalizedEnd(validTo), CreatedAt: now, UpdatedAt: now}
	if err := history.Validate(); err != nil {
		return domain.PlanHistory{}, err
	}
	if err := u.store.CreatePlanHistory(ctx, history); err != nil {
		return domain.PlanHistory{}, fmt.Errorf("register plan history: %w", err)
	}
	return history, nil
}

func (u *AccountUsecase) UpdatePlanHistory(ctx context.Context, history domain.PlanHistory) error {
	if history.UpdatedAt.IsZero() {
		history.UpdatedAt = u.clock.Now().UTC()
	}
	history.ValidFrom = history.ValidFrom.UTC()
	history.ValidTo = normalizedEnd(history.ValidTo)
	if err := history.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdatePlanHistory(ctx, history); err != nil {
		return fmt.Errorf("update plan history: %w", err)
	}
	return nil
}

func normalizedEnd(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	result := value.UTC()
	return &result
}
