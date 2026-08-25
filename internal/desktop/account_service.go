package desktop

import (
	"context"
	"errors"
	"fmt"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

// AccountService is the Wails boundary for M05. It exposes account evidence
// and explicit logical-account decisions without exposing domain structs.
type AccountService struct {
	lifecycle *sqliteadapter.Lifecycle
	usecase   *usecase.AccountUsecase
}

type AccountSnapshot struct {
	HubAccountCandidates []HubAccountCandidateSnapshot `json:"hubAccountCandidates"`
	LogicalAccounts      []LogicalAccountSnapshot      `json:"logicalAccounts"`
	PlanHistories        []PlanHistorySnapshot         `json:"planHistories"`
}

type HubAccountCandidateSnapshot struct {
	ID               string `json:"id"`
	HubID            string `json:"hubId"`
	ServiceID        string `json:"serviceId"`
	AccountKey       string `json:"accountKey"`
	DisplayName      string `json:"displayName"`
	Email            string `json:"email"`
	WorkspaceName    string `json:"workspaceName"`
	DeviceName       string `json:"deviceName"`
	State            string `json:"state"`
	LogicalAccountID string `json:"logicalAccountId"`
	FirstObservedAt  string `json:"firstObservedAt"`
	LastObservedAt   string `json:"lastObservedAt"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

type LogicalAccountSnapshot struct {
	ID          string `json:"id"`
	ServiceID   string `json:"serviceId"`
	DisplayName string `json:"displayName"`
	ArchivedAt  string `json:"archivedAt"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type PlanHistorySnapshot struct {
	ID               string `json:"id"`
	LogicalAccountID string `json:"logicalAccountId"`
	PlanVersionID    string `json:"planVersionId"`
	ValidFrom        string `json:"validFrom"`
	ValidTo          string `json:"validTo"`
	CreatedAt        string `json:"createdAt"`
	UpdatedAt        string `json:"updatedAt"`
}

type CreateLogicalAccountInput struct {
	ServiceID   string `json:"serviceId"`
	DisplayName string `json:"displayName"`
}

type UpdateLogicalAccountInput struct {
	ID          string `json:"id"`
	ServiceID   string `json:"serviceId"`
	DisplayName string `json:"displayName"`
}

type CreateLogicalAccountFromCandidateInput struct {
	CandidateID string `json:"candidateId"`
	ServiceID   string `json:"serviceId"`
	DisplayName string `json:"displayName"`
}

type SplitLogicalAccountInput struct {
	SourceID     string   `json:"sourceId"`
	ServiceID    string   `json:"serviceId"`
	DisplayName  string   `json:"displayName"`
	CandidateIDs []string `json:"candidateIds"`
}

type CreatePlanHistoryInput struct {
	LogicalAccountID string `json:"logicalAccountId"`
	PlanVersionID    string `json:"planVersionId"`
	ValidFrom        string `json:"validFrom"`
	ValidTo          string `json:"validTo"`
}

type UpdatePlanHistoryInput struct {
	ID               string `json:"id"`
	LogicalAccountID string `json:"logicalAccountId"`
	PlanVersionID    string `json:"planVersionId"`
	ValidFrom        string `json:"validFrom"`
	ValidTo          string `json:"validTo"`
}

func NewAccountService(lifecycle *sqliteadapter.Lifecycle) (*AccountService, error) {
	return NewAccountServiceWithDependencies(lifecycle, usecase.SystemClock{}, UUIDGenerator{})
}

func NewAccountServiceWithDependencies(lifecycle *sqliteadapter.Lifecycle, clock usecase.Clock, ids usecase.IDGenerator) (*AccountService, error) {
	if lifecycle == nil {
		return nil, errors.New("account lifecycle is required")
	}
	uc, err := usecase.NewAccountUsecase(lifecycle, clock, ids)
	if err != nil {
		return nil, err
	}
	return &AccountService{lifecycle: lifecycle, usecase: uc}, nil
}

func (s *AccountService) GetAccounts(ctx context.Context) (AccountSnapshot, error) {
	candidates, err := s.GetHubAccountCandidates(ctx, "", "")
	if err != nil {
		return AccountSnapshot{}, err
	}
	accounts, err := s.GetLogicalAccounts(ctx, "", true)
	if err != nil {
		return AccountSnapshot{}, err
	}
	histories, err := s.GetPlanHistories(ctx, "")
	if err != nil {
		return AccountSnapshot{}, err
	}
	return AccountSnapshot{HubAccountCandidates: candidates, LogicalAccounts: accounts, PlanHistories: histories}, nil
}

func (s *AccountService) GetHubAccountCandidates(ctx context.Context, serviceID, state string) ([]HubAccountCandidateSnapshot, error) {
	rows, err := s.lifecycle.ListHubAccountCandidates(ctx, serviceID, domain.HubAccountCandidateState(state))
	if err != nil {
		return nil, err
	}
	result := make([]HubAccountCandidateSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, hubAccountCandidateSnapshot(row))
	}
	return result, nil
}

func (s *AccountService) GetLogicalAccounts(ctx context.Context, serviceID string, includeArchived bool) ([]LogicalAccountSnapshot, error) {
	rows, err := s.lifecycle.ListLogicalAccounts(ctx, serviceID, includeArchived)
	if err != nil {
		return nil, err
	}
	result := make([]LogicalAccountSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, logicalAccountSnapshot(row))
	}
	return result, nil
}

func (s *AccountService) GetPlanHistories(ctx context.Context, logicalAccountID string) ([]PlanHistorySnapshot, error) {
	rows, err := s.lifecycle.ListPlanHistories(ctx, logicalAccountID)
	if err != nil {
		return nil, err
	}
	result := make([]PlanHistorySnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, planHistorySnapshot(row))
	}
	return result, nil
}

func (s *AccountService) CreateLogicalAccount(ctx context.Context, input CreateLogicalAccountInput) (LogicalAccountSnapshot, error) {
	account, err := s.usecase.RegisterLogicalAccount(ctx, input.ServiceID, input.DisplayName)
	if err != nil {
		return LogicalAccountSnapshot{}, err
	}
	return logicalAccountSnapshot(account), nil
}

func (s *AccountService) UpdateLogicalAccount(ctx context.Context, input UpdateLogicalAccountInput) error {
	account, err := s.logicalAccountByID(ctx, input.ID)
	if err != nil {
		return err
	}
	account.ServiceID = input.ServiceID
	account.DisplayName = input.DisplayName
	account.UpdatedAt = time.Time{}
	return s.usecase.UpdateLogicalAccount(ctx, account)
}

func (s *AccountService) ArchiveLogicalAccount(ctx context.Context, accountID string) error {
	return s.usecase.ArchiveLogicalAccount(ctx, accountID)
}

func (s *AccountService) RestoreLogicalAccount(ctx context.Context, accountID string) error {
	return s.usecase.RestoreLogicalAccount(ctx, accountID)
}

func (s *AccountService) CreateLogicalAccountFromCandidate(ctx context.Context, input CreateLogicalAccountFromCandidateInput) (LogicalAccountSnapshot, error) {
	account, err := s.usecase.CreateLogicalAccountFromCandidate(ctx, input.CandidateID, input.ServiceID, input.DisplayName)
	if err != nil {
		return LogicalAccountSnapshot{}, err
	}
	return logicalAccountSnapshot(account), nil
}

func (s *AccountService) AssociateHubAccountCandidate(ctx context.Context, candidateID, logicalAccountID string) error {
	return s.usecase.AssociateHubAccountCandidate(ctx, candidateID, logicalAccountID)
}

func (s *AccountService) RejectHubAccountCandidate(ctx context.Context, candidateID string) error {
	return s.usecase.RejectHubAccountCandidate(ctx, candidateID)
}

func (s *AccountService) ReleaseHubAccountCandidate(ctx context.Context, candidateID string) error {
	return s.usecase.ReleaseHubAccountCandidate(ctx, candidateID)
}

func (s *AccountService) SplitLogicalAccount(ctx context.Context, input SplitLogicalAccountInput) (LogicalAccountSnapshot, error) {
	account, err := s.usecase.SplitLogicalAccount(ctx, input.SourceID, input.ServiceID, input.DisplayName, input.CandidateIDs...)
	if err != nil {
		return LogicalAccountSnapshot{}, err
	}
	return logicalAccountSnapshot(account), nil
}

func (s *AccountService) MergeLogicalAccounts(ctx context.Context, sourceID, targetID string) error {
	return s.usecase.MergeLogicalAccounts(ctx, sourceID, targetID)
}

func (s *AccountService) CreatePlanHistory(ctx context.Context, input CreatePlanHistoryInput) (PlanHistorySnapshot, error) {
	validFrom, validTo, err := parseAccountPeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return PlanHistorySnapshot{}, err
	}
	history, err := s.usecase.RegisterPlanHistory(ctx, input.LogicalAccountID, input.PlanVersionID, validFrom, validTo)
	if err != nil {
		return PlanHistorySnapshot{}, err
	}
	return planHistorySnapshot(history), nil
}

func (s *AccountService) UpdatePlanHistory(ctx context.Context, input UpdatePlanHistoryInput) error {
	history, err := s.planHistoryByID(ctx, input.ID)
	if err != nil {
		return err
	}
	validFrom, validTo, err := parseAccountPeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return err
	}
	history.LogicalAccountID = input.LogicalAccountID
	history.PlanVersionID = input.PlanVersionID
	history.ValidFrom = validFrom
	history.ValidTo = validTo
	history.UpdatedAt = time.Time{}
	return s.usecase.UpdatePlanHistory(ctx, history)
}

func (s *AccountService) logicalAccountByID(ctx context.Context, id string) (domain.LogicalAccount, error) {
	rows, err := s.lifecycle.ListLogicalAccounts(ctx, "", true)
	if err != nil {
		return domain.LogicalAccount{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return domain.LogicalAccount{}, errors.New("logical account was not found")
}

func (s *AccountService) planHistoryByID(ctx context.Context, id string) (domain.PlanHistory, error) {
	rows, err := s.lifecycle.ListPlanHistories(ctx, "")
	if err != nil {
		return domain.PlanHistory{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return domain.PlanHistory{}, errors.New("plan history was not found")
}

func parseAccountPeriod(fromValue, toValue string) (time.Time, *time.Time, error) {
	from, err := parseAccountTimestamp(fromValue)
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("validFrom must be RFC3339Nano: %w", err)
	}
	if toValue == "" {
		return from, nil, nil
	}
	to, err := parseAccountTimestamp(toValue)
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("validTo must be RFC3339Nano: %w", err)
	}
	return from, &to, nil
}

func parseAccountTimestamp(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, errors.New("timestamp is required")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func hubAccountCandidateSnapshot(value domain.HubAccountCandidate) HubAccountCandidateSnapshot {
	return HubAccountCandidateSnapshot{
		ID: value.ID, HubID: value.HubID, ServiceID: value.ServiceID, AccountKey: value.AccountKey,
		DisplayName: value.DisplayName, Email: value.Email, WorkspaceName: value.WorkspaceName, DeviceName: value.DeviceName,
		State: string(value.State), LogicalAccountID: accountID(value.LogicalAccountID), FirstObservedAt: accountTimePtr(value.FirstObservedAt),
		LastObservedAt: accountTimePtr(value.LastObservedAt), CreatedAt: accountTime(value.CreatedAt), UpdatedAt: accountTime(value.UpdatedAt),
	}
}

func logicalAccountSnapshot(value domain.LogicalAccount) LogicalAccountSnapshot {
	return LogicalAccountSnapshot{ID: value.ID, ServiceID: value.ServiceID, DisplayName: value.DisplayName,
		ArchivedAt: accountTimePtr(value.ArchivedAt), CreatedAt: accountTime(value.CreatedAt), UpdatedAt: accountTime(value.UpdatedAt)}
}

func planHistorySnapshot(value domain.PlanHistory) PlanHistorySnapshot {
	return PlanHistorySnapshot{ID: value.ID, LogicalAccountID: value.LogicalAccountID, PlanVersionID: value.PlanVersionID,
		ValidFrom: accountTime(value.ValidFrom), ValidTo: accountTimePtr(value.ValidTo), CreatedAt: accountTime(value.CreatedAt), UpdatedAt: accountTime(value.UpdatedAt)}
}

func accountID(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func accountTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func accountTimePtr(value *time.Time) string {
	if value == nil {
		return ""
	}
	return accountTime(*value)
}
