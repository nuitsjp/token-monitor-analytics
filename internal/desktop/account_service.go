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
	linking   *usecase.LinkingUsecase
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

type LinkingSnapshot struct {
	UsageCostSources            []UsageCostSourceSnapshot             `json:"usageCostSources"`
	UsageLimitSources           []UsageLimitSourceSnapshot            `json:"usageLimitSources"`
	UsageCostAssociations       []UsageCostAssociationSnapshot        `json:"usageCostAssociations"`
	UsageLimitAssociations      []UsageLimitAssociationSnapshot       `json:"usageLimitAssociations"`
	UsageCostSourceCompleteness []UsageCostSourceCompletenessSnapshot `json:"usageCostSourceCompleteness"`
	HubSwitches                 []HubSwitchSnapshot                   `json:"hubSwitches"`
}

type UsageCostSourceSnapshot struct {
	ID                   string `json:"id"`
	HubID                string `json:"hubId"`
	DeviceID             string `json:"deviceId"`
	RawServiceIdentifier string `json:"rawServiceIdentifier"`
	CreatedAt            string `json:"createdAt"`
}

type UsageLimitSourceSnapshot struct {
	ID                   string `json:"id"`
	HubID                string `json:"hubId"`
	DeviceID             string `json:"deviceId"`
	AccountKey           string `json:"accountKey"`
	RawServiceIdentifier string `json:"rawServiceIdentifier"`
	WindowKey            string `json:"windowKey"`
	NormalizedKind       string `json:"normalizedKind"`
	NormalizedMetric     string `json:"normalizedMetric"`
	NormalizedLabel      string `json:"normalizedLabel"`
	CreatedAt            string `json:"createdAt"`
}

type UsageCostAssociationSnapshot struct {
	ID                string `json:"id"`
	UsageCostSourceID string `json:"usageCostSourceId"`
	LogicalAccountID  string `json:"logicalAccountId"`
	ValidFrom         string `json:"validFrom"`
	ValidTo           string `json:"validTo"`
	CreatedAt         string `json:"createdAt"`
	UpdatedAt         string `json:"updatedAt"`
}

type UsageLimitAssociationSnapshot struct {
	ID                 string `json:"id"`
	UsageLimitSourceID string `json:"usageLimitSourceId"`
	LogicalAccountID   string `json:"logicalAccountId"`
	LimitDefinitionID  string `json:"limitDefinitionId"`
	ValidFrom          string `json:"validFrom"`
	ValidTo            string `json:"validTo"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}

type UsageCostSourceCompletenessSnapshot struct {
	ID                string   `json:"id"`
	UsageCostSourceID string   `json:"usageCostSourceId"`
	ValidFrom         string   `json:"validFrom"`
	ValidTo           string   `json:"validTo"`
	State             string   `json:"state"`
	LogicalAccountIDs []string `json:"logicalAccountIds"`
	ExcludedActivity  []string `json:"excludedActivity"`
	CreatedAt         string   `json:"createdAt"`
	UpdatedAt         string   `json:"updatedAt"`
}

type HubSwitchSnapshot struct {
	ID                 string `json:"id"`
	OldHubID           string `json:"oldHubId"`
	OldDeviceID        string `json:"oldDeviceId"`
	NewHubID           string `json:"newHubId"`
	NewDeviceID        string `json:"newDeviceId"`
	CollectionDeviceID string `json:"collectionDeviceId"`
	SwitchedAt         string `json:"switchedAt"`
	CreatedAt          string `json:"createdAt"`
}

type ImpactIntervalSnapshot struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type ImpactPreviewSnapshot struct {
	SourceID                     string                   `json:"sourceId"`
	SourceKind                   string                   `json:"sourceKind"`
	IntervalStart                string                   `json:"intervalStart"`
	IntervalEnd                  string                   `json:"intervalEnd"`
	AffectedObservationIDs       []string                 `json:"affectedObservationIds"`
	AffectedCalculationIntervals []ImpactIntervalSnapshot `json:"affectedCalculationIntervals"`
	AffectedDerivedResultIDs     []string                 `json:"affectedDerivedResultIds"`
}

type UsageCostAssociationInput struct {
	ID                string `json:"id"`
	UsageCostSourceID string `json:"usageCostSourceId"`
	LogicalAccountID  string `json:"logicalAccountId"`
	ValidFrom         string `json:"validFrom"`
	ValidTo           string `json:"validTo"`
}

type UsageLimitAssociationInput struct {
	ID                 string `json:"id"`
	UsageLimitSourceID string `json:"usageLimitSourceId"`
	LogicalAccountID   string `json:"logicalAccountId"`
	LimitDefinitionID  string `json:"limitDefinitionId"`
	ValidFrom          string `json:"validFrom"`
	ValidTo            string `json:"validTo"`
}

type UsageCostSourceCompletenessInput struct {
	ID                string   `json:"id"`
	UsageCostSourceID string   `json:"usageCostSourceId"`
	ValidFrom         string   `json:"validFrom"`
	ValidTo           string   `json:"validTo"`
	State             string   `json:"state"`
	LogicalAccountIDs []string `json:"logicalAccountIds"`
	ExcludedActivity  []string `json:"excludedActivity"`
}

type HubSwitchInput struct {
	ID                 string `json:"id"`
	OldHubID           string `json:"oldHubId"`
	OldDeviceID        string `json:"oldDeviceId"`
	NewHubID           string `json:"newHubId"`
	NewDeviceID        string `json:"newDeviceId"`
	CollectionDeviceID string `json:"collectionDeviceId"`
	SwitchedAt         string `json:"switchedAt"`
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
	linking, err := usecase.NewLinkingUsecase(lifecycle, clock, ids)
	if err != nil {
		return nil, err
	}
	return &AccountService{lifecycle: lifecycle, usecase: uc, linking: linking}, nil
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

func (s *AccountService) GetLinkingSnapshot(ctx context.Context) (LinkingSnapshot, error) {
	costSources, err := s.lifecycle.ListUsageCostSources(ctx, "")
	if err != nil {
		return LinkingSnapshot{}, err
	}
	limitSources, err := s.lifecycle.ListUsageLimitSources(ctx, "")
	if err != nil {
		return LinkingSnapshot{}, err
	}
	costAssociations, err := s.lifecycle.ListUsageCostAssociations(ctx, "")
	if err != nil {
		return LinkingSnapshot{}, err
	}
	limitAssociations, err := s.lifecycle.ListUsageLimitAssociations(ctx, "")
	if err != nil {
		return LinkingSnapshot{}, err
	}
	completeness, err := s.lifecycle.ListUsageCostSourceCompleteness(ctx, "")
	if err != nil {
		return LinkingSnapshot{}, err
	}
	switches, err := s.lifecycle.ListHubSwitches(ctx)
	if err != nil {
		return LinkingSnapshot{}, err
	}
	return LinkingSnapshot{
		UsageCostSources:            mapUsageCostSources(costSources),
		UsageLimitSources:           mapUsageLimitSources(limitSources),
		UsageCostAssociations:       mapUsageCostAssociations(costAssociations),
		UsageLimitAssociations:      mapUsageLimitAssociations(limitAssociations),
		UsageCostSourceCompleteness: mapCompleteness(completeness),
		HubSwitches:                 mapHubSwitches(switches),
	}, nil
}

func (s *AccountService) CreateUsageCostAssociation(ctx context.Context, input UsageCostAssociationInput) (UsageCostAssociationSnapshot, error) {
	association, err := usageCostAssociationFromInput(input)
	if err != nil {
		return UsageCostAssociationSnapshot{}, err
	}
	created, err := s.linking.AssociateUsageCostSource(ctx, association)
	if err != nil {
		return UsageCostAssociationSnapshot{}, err
	}
	return usageCostAssociationSnapshot(created), nil
}

func (s *AccountService) UpdateUsageCostAssociation(ctx context.Context, input UsageCostAssociationInput) error {
	existing, err := s.usageCostAssociationByID(ctx, input.ID)
	if err != nil {
		return err
	}
	association, err := usageCostAssociationFromInput(input)
	if err != nil {
		return err
	}
	association.CreatedAt = existing.CreatedAt
	return s.linking.UpdateUsageCostAssociation(ctx, association)
}

func (s *AccountService) PreviewUsageCostAssociation(ctx context.Context, input UsageCostAssociationInput) (ImpactPreviewSnapshot, error) {
	association, err := usageCostAssociationFromInput(input)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	preview, err := s.linking.PreviewUsageCostAssociation(ctx, association)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	return impactPreviewSnapshot(preview), nil
}

func (s *AccountService) CreateUsageLimitAssociation(ctx context.Context, input UsageLimitAssociationInput) (UsageLimitAssociationSnapshot, error) {
	association, err := usageLimitAssociationFromInput(input)
	if err != nil {
		return UsageLimitAssociationSnapshot{}, err
	}
	created, err := s.linking.AssociateUsageLimitSource(ctx, association)
	if err != nil {
		return UsageLimitAssociationSnapshot{}, err
	}
	return usageLimitAssociationSnapshot(created), nil
}

func (s *AccountService) UpdateUsageLimitAssociation(ctx context.Context, input UsageLimitAssociationInput) error {
	existing, err := s.usageLimitAssociationByID(ctx, input.ID)
	if err != nil {
		return err
	}
	association, err := usageLimitAssociationFromInput(input)
	if err != nil {
		return err
	}
	association.CreatedAt = existing.CreatedAt
	return s.linking.UpdateUsageLimitAssociation(ctx, association)
}

func (s *AccountService) PreviewUsageLimitAssociation(ctx context.Context, input UsageLimitAssociationInput) (ImpactPreviewSnapshot, error) {
	association, err := usageLimitAssociationFromInput(input)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	preview, err := s.linking.PreviewUsageLimitAssociation(ctx, association)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	return impactPreviewSnapshot(preview), nil
}

func (s *AccountService) PreviewUsageCostSourceCompleteness(ctx context.Context, input UsageCostSourceCompletenessInput) (ImpactPreviewSnapshot, error) {
	completeness, err := completenessFromInput(input)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	preview, err := s.linking.PreviewUsageCostSourceCompleteness(ctx, completeness)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	return impactPreviewSnapshot(preview), nil
}

func (s *AccountService) ConfirmUsageCostSourceCompleteness(ctx context.Context, input UsageCostSourceCompletenessInput) (UsageCostSourceCompletenessSnapshot, error) {
	completeness, err := completenessFromInput(input)
	if err != nil {
		return UsageCostSourceCompletenessSnapshot{}, err
	}
	confirmed, err := s.linking.ConfirmUsageCostSourceCompleteness(ctx, completeness)
	if err != nil {
		return UsageCostSourceCompletenessSnapshot{}, err
	}
	return completenessSnapshot(confirmed), nil
}

func (s *AccountService) UpdateUsageCostSourceCompleteness(ctx context.Context, input UsageCostSourceCompletenessInput) error {
	existing, err := s.completenessByID(ctx, input.ID)
	if err != nil {
		return err
	}
	completeness, err := completenessFromInput(input)
	if err != nil {
		return err
	}
	completeness.CreatedAt = existing.CreatedAt
	return s.linking.UpdateUsageCostSourceCompleteness(ctx, completeness)
}

func (s *AccountService) PreviewHubSwitch(ctx context.Context, input HubSwitchInput) (ImpactPreviewSnapshot, error) {
	switchRecord, err := hubSwitchFromInput(input)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	preview, err := s.linking.PreviewHubSwitch(ctx, switchRecord)
	if err != nil {
		return ImpactPreviewSnapshot{}, err
	}
	return impactPreviewSnapshot(preview), nil
}

func (s *AccountService) ConfirmHubSwitch(ctx context.Context, input HubSwitchInput) (HubSwitchSnapshot, error) {
	switchRecord, err := hubSwitchFromInput(input)
	if err != nil {
		return HubSwitchSnapshot{}, err
	}
	confirmed, err := s.linking.ConfirmHubSwitch(ctx, switchRecord)
	if err != nil {
		return HubSwitchSnapshot{}, err
	}
	return hubSwitchSnapshot(confirmed), nil
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

func usageCostAssociationFromInput(input UsageCostAssociationInput) (domain.UsageCostAssociation, error) {
	from, to, err := parseAccountPeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.UsageCostAssociation{}, err
	}
	return domain.UsageCostAssociation{
		ID:                input.ID,
		UsageCostSourceID: input.UsageCostSourceID,
		LogicalAccountID:  input.LogicalAccountID,
		ValidFrom:         from,
		ValidTo:           to,
	}, nil
}

func usageLimitAssociationFromInput(input UsageLimitAssociationInput) (domain.UsageLimitAssociation, error) {
	from, to, err := parseAccountPeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.UsageLimitAssociation{}, err
	}
	return domain.UsageLimitAssociation{
		ID:                 input.ID,
		UsageLimitSourceID: input.UsageLimitSourceID,
		LogicalAccountID:   input.LogicalAccountID,
		LimitDefinitionID:  input.LimitDefinitionID,
		ValidFrom:          from,
		ValidTo:            to,
	}, nil
}

func completenessFromInput(input UsageCostSourceCompletenessInput) (domain.UsageCostSourceCompleteness, error) {
	from, to, err := parseAccountPeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.UsageCostSourceCompleteness{}, err
	}
	return domain.UsageCostSourceCompleteness{
		ID:                input.ID,
		UsageCostSourceID: input.UsageCostSourceID,
		ValidFrom:         from,
		ValidTo:           to,
		State:             domain.CompletenessState(input.State),
		LogicalAccountIDs: append([]string(nil), input.LogicalAccountIDs...),
		ExcludedActivity:  append([]string(nil), input.ExcludedActivity...),
	}, nil
}

func hubSwitchFromInput(input HubSwitchInput) (domain.HubSwitch, error) {
	switchedAt, err := parseAccountTimestamp(input.SwitchedAt)
	if err != nil {
		return domain.HubSwitch{}, fmt.Errorf("switchedAt must be RFC3339Nano: %w", err)
	}
	return domain.HubSwitch{
		ID:                 input.ID,
		OldHubID:           input.OldHubID,
		OldDeviceID:        input.OldDeviceID,
		NewHubID:           input.NewHubID,
		NewDeviceID:        input.NewDeviceID,
		CollectionDeviceID: input.CollectionDeviceID,
		SwitchedAt:         switchedAt,
	}, nil
}

func (s *AccountService) usageCostAssociationByID(ctx context.Context, id string) (domain.UsageCostAssociation, error) {
	items, err := s.lifecycle.ListUsageCostAssociations(ctx, "")
	if err != nil {
		return domain.UsageCostAssociation{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return domain.UsageCostAssociation{}, errors.New("usage cost association was not found")
}

func (s *AccountService) usageLimitAssociationByID(ctx context.Context, id string) (domain.UsageLimitAssociation, error) {
	items, err := s.lifecycle.ListUsageLimitAssociations(ctx, "")
	if err != nil {
		return domain.UsageLimitAssociation{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return domain.UsageLimitAssociation{}, errors.New("usage limit association was not found")
}

func (s *AccountService) completenessByID(ctx context.Context, id string) (domain.UsageCostSourceCompleteness, error) {
	items, err := s.lifecycle.ListUsageCostSourceCompleteness(ctx, "")
	if err != nil {
		return domain.UsageCostSourceCompleteness{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return domain.UsageCostSourceCompleteness{}, errors.New("usage cost source completeness was not found")
}

func mapUsageCostSources(items []domain.UsageCostSource) []UsageCostSourceSnapshot {
	result := make([]UsageCostSourceSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, UsageCostSourceSnapshot{
			ID: item.ID, HubID: item.HubID, DeviceID: item.DeviceID,
			RawServiceIdentifier: item.RawServiceIdentifier, CreatedAt: accountTime(item.CreatedAt),
		})
	}
	return result
}

func mapUsageLimitSources(items []domain.UsageLimitSource) []UsageLimitSourceSnapshot {
	result := make([]UsageLimitSourceSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, UsageLimitSourceSnapshot{
			ID: item.ID, HubID: item.HubID, DeviceID: item.DeviceID, AccountKey: item.AccountKey,
			RawServiceIdentifier: item.RawServiceIdentifier, WindowKey: item.WindowKey,
			NormalizedKind: item.NormalizedKind, NormalizedMetric: item.NormalizedMetric,
			NormalizedLabel: item.NormalizedLabel, CreatedAt: accountTime(item.CreatedAt),
		})
	}
	return result
}

func mapUsageCostAssociations(items []domain.UsageCostAssociation) []UsageCostAssociationSnapshot {
	result := make([]UsageCostAssociationSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, usageCostAssociationSnapshot(item))
	}
	return result
}

func mapUsageLimitAssociations(items []domain.UsageLimitAssociation) []UsageLimitAssociationSnapshot {
	result := make([]UsageLimitAssociationSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, usageLimitAssociationSnapshot(item))
	}
	return result
}

func mapCompleteness(items []domain.UsageCostSourceCompleteness) []UsageCostSourceCompletenessSnapshot {
	result := make([]UsageCostSourceCompletenessSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, completenessSnapshot(item))
	}
	return result
}

func mapHubSwitches(items []domain.HubSwitch) []HubSwitchSnapshot {
	result := make([]HubSwitchSnapshot, 0, len(items))
	for _, item := range items {
		result = append(result, hubSwitchSnapshot(item))
	}
	return result
}

func usageCostAssociationSnapshot(value domain.UsageCostAssociation) UsageCostAssociationSnapshot {
	return UsageCostAssociationSnapshot{
		ID: value.ID, UsageCostSourceID: value.UsageCostSourceID, LogicalAccountID: value.LogicalAccountID,
		ValidFrom: accountTime(value.ValidFrom), ValidTo: accountTimePtr(value.ValidTo),
		CreatedAt: accountTime(value.CreatedAt), UpdatedAt: accountTime(value.UpdatedAt),
	}
}

func usageLimitAssociationSnapshot(value domain.UsageLimitAssociation) UsageLimitAssociationSnapshot {
	return UsageLimitAssociationSnapshot{
		ID: value.ID, UsageLimitSourceID: value.UsageLimitSourceID, LogicalAccountID: value.LogicalAccountID,
		LimitDefinitionID: value.LimitDefinitionID, ValidFrom: accountTime(value.ValidFrom),
		ValidTo: accountTimePtr(value.ValidTo), CreatedAt: accountTime(value.CreatedAt),
		UpdatedAt: accountTime(value.UpdatedAt),
	}
}

func completenessSnapshot(value domain.UsageCostSourceCompleteness) UsageCostSourceCompletenessSnapshot {
	return UsageCostSourceCompletenessSnapshot{
		ID: value.ID, UsageCostSourceID: value.UsageCostSourceID, ValidFrom: accountTime(value.ValidFrom),
		ValidTo: accountTimePtr(value.ValidTo), State: string(value.State),
		LogicalAccountIDs: append([]string(nil), value.LogicalAccountIDs...),
		ExcludedActivity:  append([]string(nil), value.ExcludedActivity...),
		CreatedAt:         accountTime(value.CreatedAt), UpdatedAt: accountTime(value.UpdatedAt),
	}
}

func hubSwitchSnapshot(value domain.HubSwitch) HubSwitchSnapshot {
	return HubSwitchSnapshot{
		ID: value.ID, OldHubID: value.OldHubID, OldDeviceID: value.OldDeviceID,
		NewHubID: value.NewHubID, NewDeviceID: value.NewDeviceID,
		CollectionDeviceID: value.CollectionDeviceID, SwitchedAt: accountTime(value.SwitchedAt),
		CreatedAt: accountTime(value.CreatedAt),
	}
}

func impactPreviewSnapshot(value domain.ImpactPreview) ImpactPreviewSnapshot {
	intervals := make([]ImpactIntervalSnapshot, 0, len(value.AffectedCalculationIntervals))
	for _, item := range value.AffectedCalculationIntervals {
		intervals = append(intervals, ImpactIntervalSnapshot{Start: accountTime(item.Start), End: accountTime(item.End)})
	}
	return ImpactPreviewSnapshot{
		SourceID: value.SourceID, SourceKind: value.SourceKind,
		IntervalStart: accountTime(value.IntervalStart), IntervalEnd: accountTime(value.IntervalEnd),
		AffectedObservationIDs:       append([]string(nil), value.AffectedObservationIDs...),
		AffectedCalculationIntervals: intervals,
		AffectedDerivedResultIDs:     append([]string(nil), value.AffectedDerivedResultIDs...),
	}
}
