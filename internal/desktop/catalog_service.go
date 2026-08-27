package desktop

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

// CatalogService is the Wails boundary for M06. Raw identifiers and reported
// names are returned exactly as stored; this service never guesses a product
// catalog from a string.
type CatalogService struct {
	lifecycle *sqliteadapter.Lifecycle
	usecase   *usecase.CatalogUsecase
	clock     usecase.Clock
	gate      *usecase.MaintenanceGate
}

type CatalogSnapshot struct {
	Services                  []ServiceSnapshot                  `json:"services"`
	ServiceIdentifierMappings []ServiceIdentifierMappingSnapshot `json:"serviceIdentifierMappings"`
	LimitDefinitions          []LimitDefinitionSnapshot          `json:"limitDefinitions"`
	Plans                     []PlanSnapshot                     `json:"plans"`
	PlanVersions              []PlanVersionSnapshot              `json:"planVersions"`
	PlanLimitRules            []PlanLimitRuleSnapshot            `json:"planLimitRules"`
	StandardPrices            []StandardPriceSnapshot            `json:"standardPrices"`
	IdentificationCandidates  []IdentificationCandidateSnapshot  `json:"identificationCandidates"`
	LabelChangeCandidates     []LabelChangeCandidateSnapshot     `json:"labelChangeCandidates"`
}

type ServiceSnapshot struct {
	ID          string `json:"id"`
	Provider    string `json:"provider"`
	Name        string `json:"name"`
	OfficialKey string `json:"officialKey"`
	ArchivedAt  string `json:"archivedAt"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type ServiceIdentifierMappingSnapshot struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	RawIdentifier string `json:"rawIdentifier"`
	ServiceID     string `json:"serviceId"`
	ValidFrom     string `json:"validFrom"`
	ValidTo       string `json:"validTo"`
	CreatedAt     string `json:"createdAt"`
}

type LimitDefinitionSnapshot struct {
	ID                  string `json:"id"`
	ServiceID           string `json:"serviceId"`
	CycleType           string `json:"cycleType"`
	Meaning             string `json:"meaning"`
	Unit                string `json:"unit"`
	BillingConfirmation string `json:"billingConfirmation"`
	ArchivedAt          string `json:"archivedAt"`
	CreatedAt           string `json:"createdAt"`
	UpdatedAt           string `json:"updatedAt"`
}

type PlanSnapshot struct {
	ID         string `json:"id"`
	ServiceID  string `json:"serviceId"`
	Name       string `json:"name"`
	IsBaseline bool   `json:"isBaseline"`
	ArchivedAt string `json:"archivedAt"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type PlanVersionSnapshot struct {
	ID                string `json:"id"`
	PlanID            string `json:"planId"`
	Name              string `json:"name"`
	ValidFrom         string `json:"validFrom"`
	ValidTo           string `json:"validTo"`
	OfficialSourceURL string `json:"officialSourceUrl"`
	CreatedAt         string `json:"createdAt"`
}

type PlanLimitRuleSnapshot struct {
	ID                string   `json:"id"`
	PlanVersionID     string   `json:"planVersionId"`
	LimitDefinitionID string   `json:"limitDefinitionId"`
	Limit             *float64 `json:"limit"`
	Multiplier        *float64 `json:"multiplier"`
	OfficialSourceURL string   `json:"officialSourceUrl"`
	CreatedAt         string   `json:"createdAt"`
}

type StandardPriceSnapshot struct {
	ID                string  `json:"id"`
	PlanVersionID     string  `json:"planVersionId"`
	USDMonthlyPerSeat float64 `json:"usdMonthlyPerSeat"`
	SourceURL         string  `json:"sourceUrl"`
	ValidFrom         string  `json:"validFrom"`
	ValidTo           string  `json:"validTo"`
	CreatedAt         string  `json:"createdAt"`
}

type CandidateObservationSnapshot struct {
	ID                string `json:"id"`
	CandidateID       string `json:"candidateId"`
	HubID             string `json:"hubId"`
	HubAccountDisplay string `json:"hubAccountDisplay"`
	ObservedAt        string `json:"observedAt"`
}

type IdentificationCandidateSnapshot struct {
	ID                        string                         `json:"id"`
	RawLimitServiceIdentifier string                         `json:"rawLimitServiceIdentifier"`
	RawReportedPlanName       string                         `json:"rawReportedPlanName"`
	State                     string                         `json:"state"`
	ServiceID                 string                         `json:"serviceId"`
	PlanID                    string                         `json:"planId"`
	FirstObservedAt           string                         `json:"firstObservedAt"`
	LastObservedAt            string                         `json:"lastObservedAt"`
	CreatedAt                 string                         `json:"createdAt"`
	UpdatedAt                 string                         `json:"updatedAt"`
	Observations              []CandidateObservationSnapshot `json:"observations"`
}

type LabelChangeWindowSnapshot struct {
	ID          string `json:"id"`
	CandidateID string `json:"candidateId"`
	WindowKey   string `json:"windowKey"`
	Label       string `json:"label"`
	ObservedAt  string `json:"observedAt"`
}

type LabelChangeCandidateSnapshot struct {
	ID                        string                      `json:"id"`
	HubID                     string                      `json:"hubId"`
	DeviceRecordKey           string                      `json:"deviceRecordKey"`
	HubAccountKey             string                      `json:"hubAccountKey"`
	RawLimitServiceIdentifier string                      `json:"rawLimitServiceIdentifier"`
	NormalizedKind            string                      `json:"normalizedKind"`
	NormalizedMetric          string                      `json:"normalizedMetric"`
	OldLabel                  string                      `json:"oldLabel"`
	NewLabel                  string                      `json:"newLabel"`
	State                     string                      `json:"state"`
	LimitDefinitionID         string                      `json:"limitDefinitionId"`
	FirstObservedAt           string                      `json:"firstObservedAt"`
	LastObservedAt            string                      `json:"lastObservedAt"`
	CreatedAt                 string                      `json:"createdAt"`
	UpdatedAt                 string                      `json:"updatedAt"`
	Windows                   []LabelChangeWindowSnapshot `json:"windows"`
}

type CreateServiceInput struct {
	Provider    string `json:"provider"`
	Name        string `json:"name"`
	OfficialKey string `json:"officialKey"`
}

type UpdateServiceInput struct {
	ID          string `json:"id"`
	Provider    string `json:"provider"`
	Name        string `json:"name"`
	OfficialKey string `json:"officialKey"`
	Archived    bool   `json:"archived"`
}

type ServiceIdentifierMappingInput struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	RawIdentifier string `json:"rawIdentifier"`
	ServiceID     string `json:"serviceId"`
	ValidFrom     string `json:"validFrom"`
	ValidTo       string `json:"validTo"`
}

type LimitDefinitionInput struct {
	ID                  string `json:"id"`
	ServiceID           string `json:"serviceId"`
	CycleType           string `json:"cycleType"`
	Meaning             string `json:"meaning"`
	Unit                string `json:"unit"`
	BillingConfirmation string `json:"billingConfirmation"`
}

type PlanInput struct {
	ID         string `json:"id"`
	ServiceID  string `json:"serviceId"`
	Name       string `json:"name"`
	IsBaseline bool   `json:"isBaseline"`
}

type PlanVersionInput struct {
	ID                string `json:"id"`
	PlanID            string `json:"planId"`
	Name              string `json:"name"`
	ValidFrom         string `json:"validFrom"`
	ValidTo           string `json:"validTo"`
	OfficialSourceURL string `json:"officialSourceUrl"`
}

type PlanLimitRuleInput struct {
	ID                string   `json:"id"`
	PlanVersionID     string   `json:"planVersionId"`
	LimitDefinitionID string   `json:"limitDefinitionId"`
	Limit             *float64 `json:"limit"`
	Multiplier        *float64 `json:"multiplier"`
	OfficialSourceURL string   `json:"officialSourceUrl"`
}

type StandardPriceInput struct {
	ID                string  `json:"id"`
	PlanVersionID     string  `json:"planVersionId"`
	USDMonthlyPerSeat float64 `json:"usdMonthlyPerSeat"`
	SourceURL         string  `json:"sourceUrl"`
	ValidFrom         string  `json:"validFrom"`
	ValidTo           string  `json:"validTo"`
}

type CandidateCorrectionInput struct {
	CandidateID               string `json:"candidateId"`
	RawLimitServiceIdentifier string `json:"rawLimitServiceIdentifier"`
	RawReportedPlanName       string `json:"rawReportedPlanName"`
}

type CandidateSplitInput struct {
	SourceCandidateID         string   `json:"sourceCandidateId"`
	RawLimitServiceIdentifier string   `json:"rawLimitServiceIdentifier"`
	RawReportedPlanName       string   `json:"rawReportedPlanName"`
	ObservationIDs            []string `json:"observationIds"`
}

type CandidateDecisionInput struct {
	CandidateID string `json:"candidateId"`
	ServiceID   string `json:"serviceId"`
	PlanID      string `json:"planId"`
}

type LabelChangeDecisionInput struct {
	CandidateID       string `json:"candidateId"`
	State             string `json:"state"`
	LimitDefinitionID string `json:"limitDefinitionId"`
}

func NewCatalogService(lifecycle *sqliteadapter.Lifecycle, gate *usecase.MaintenanceGate) (*CatalogService, error) {
	if lifecycle == nil || gate == nil {
		return nil, errors.New("catalog lifecycle and maintenance gate are required")
	}
	uc, err := usecase.NewCatalogUsecase(lifecycle, usecase.SystemClock{}, UUIDGenerator{})
	if err != nil {
		return nil, err
	}
	return &CatalogService{lifecycle: lifecycle, usecase: uc, clock: usecase.SystemClock{}, gate: gate}, nil
}

func NewCatalogServiceWithDependencies(lifecycle *sqliteadapter.Lifecycle, clock usecase.Clock, ids usecase.IDGenerator, gate *usecase.MaintenanceGate) (*CatalogService, error) {
	if lifecycle == nil || gate == nil {
		return nil, errors.New("catalog lifecycle and maintenance gate are required")
	}
	uc, err := usecase.NewCatalogUsecase(lifecycle, clock, ids)
	if err != nil {
		return nil, err
	}
	return &CatalogService{lifecycle: lifecycle, usecase: uc, clock: clock, gate: gate}, nil
}

func (s *CatalogService) GetCatalog(ctx context.Context) (CatalogSnapshot, error) {
	services, err := s.GetServices(ctx, false)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	mappings, err := s.GetServiceIdentifierMappings(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	definitions, err := s.GetLimitDefinitions(ctx, false)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	plans, err := s.GetPlans(ctx, "", false)
	if err != nil {
		return CatalogSnapshot{}, err
	}
	versions, err := s.GetPlanVersions(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	rules, err := s.GetPlanLimitRules(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	prices, err := s.GetStandardPrices(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	candidates, err := s.GetIdentificationCandidates(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	labels, err := s.GetLabelChangeCandidates(ctx, "")
	if err != nil {
		return CatalogSnapshot{}, err
	}
	return CatalogSnapshot{Services: services, ServiceIdentifierMappings: mappings, LimitDefinitions: definitions, Plans: plans, PlanVersions: versions, PlanLimitRules: rules, StandardPrices: prices, IdentificationCandidates: candidates, LabelChangeCandidates: labels}, nil
}

func (s *CatalogService) GetServices(ctx context.Context, includeArchived bool) ([]ServiceSnapshot, error) {
	rows, err := s.lifecycle.ListServices(ctx, includeArchived)
	if err != nil {
		return nil, err
	}
	result := make([]ServiceSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, serviceSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetServiceIdentifierMappings(ctx context.Context, kind string) ([]ServiceIdentifierMappingSnapshot, error) {
	rows, err := s.lifecycle.ListServiceIdentifierMappings(ctx, domain.ServiceIdentifierKind(kind), "")
	if err != nil {
		return nil, err
	}
	result := make([]ServiceIdentifierMappingSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, mappingSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetLimitDefinitions(ctx context.Context, includeArchived bool) ([]LimitDefinitionSnapshot, error) {
	rows, err := s.lifecycle.ListLimitDefinitions(ctx, includeArchived)
	if err != nil {
		return nil, err
	}
	result := make([]LimitDefinitionSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, limitDefinitionSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetPlans(ctx context.Context, serviceID string, includeArchived bool) ([]PlanSnapshot, error) {
	rows, err := s.lifecycle.ListPlans(ctx, serviceID, includeArchived)
	if err != nil {
		return nil, err
	}
	result := make([]PlanSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, planSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetPlanVersions(ctx context.Context, planID string) ([]PlanVersionSnapshot, error) {
	rows, err := s.lifecycle.ListPlanVersions(ctx, planID)
	if err != nil {
		return nil, err
	}
	result := make([]PlanVersionSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, planVersionSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetPlanLimitRules(ctx context.Context, planVersionID string) ([]PlanLimitRuleSnapshot, error) {
	rows, err := s.lifecycle.ListPlanLimitRules(ctx, planVersionID)
	if err != nil {
		return nil, err
	}
	result := make([]PlanLimitRuleSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, planLimitRuleSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetStandardPrices(ctx context.Context, planVersionID string) ([]StandardPriceSnapshot, error) {
	rows, err := s.lifecycle.ListStandardPrices(ctx, planVersionID)
	if err != nil {
		return nil, err
	}
	result := make([]StandardPriceSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, standardPriceSnapshot(row))
	}
	return result, nil
}

func (s *CatalogService) GetIdentificationCandidates(ctx context.Context, state string) ([]IdentificationCandidateSnapshot, error) {
	rows, err := s.lifecycle.ListIdentificationCandidates(ctx, domain.CandidateState(state))
	if err != nil {
		return nil, err
	}
	result := make([]IdentificationCandidateSnapshot, 0, len(rows))
	for _, row := range rows {
		observations, listErr := s.lifecycle.ListIdentificationCandidateObservations(ctx, row.ID)
		if listErr != nil {
			return nil, listErr
		}
		item := candidateSnapshot(row)
		item.Observations = make([]CandidateObservationSnapshot, 0, len(observations))
		for _, observation := range observations {
			item.Observations = append(item.Observations, CandidateObservationSnapshot{ID: observation.ID, CandidateID: observation.CandidateID, HubID: observation.HubID, HubAccountDisplay: observation.HubAccountDisplay, ObservedAt: formatOptional(observation.ObservedAt)})
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *CatalogService) GetLabelChangeCandidates(ctx context.Context, state string) ([]LabelChangeCandidateSnapshot, error) {
	rows, err := s.lifecycle.ListLimitLabelChangeCandidates(ctx, domain.LabelChangeState(state))
	if err != nil {
		return nil, err
	}
	result := make([]LabelChangeCandidateSnapshot, 0, len(rows))
	for _, row := range rows {
		windows, listErr := s.lifecycle.ListLimitLabelChangeWindows(ctx, row.ID)
		if listErr != nil {
			return nil, listErr
		}
		item := labelCandidateSnapshot(row)
		item.Windows = make([]LabelChangeWindowSnapshot, 0, len(windows))
		for _, window := range windows {
			item.Windows = append(item.Windows, LabelChangeWindowSnapshot{ID: window.ID, CandidateID: window.CandidateID, WindowKey: window.WindowKey, Label: window.Label, ObservedAt: formatOptional(window.ObservedAt)})
		}
		result = append(result, item)
	}
	return result, nil
}

func (s *CatalogService) CreateService(ctx context.Context, input CreateServiceInput) (ServiceSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return ServiceSnapshot{}, err
	}
	defer release()
	row, err := s.usecase.RegisterService(ctx, input.Provider, input.Name, input.OfficialKey)
	if err != nil {
		return ServiceSnapshot{}, err
	}
	return serviceSnapshot(row), nil
}

func (s *CatalogService) UpdateService(ctx context.Context, input UpdateServiceInput) (ServiceSnapshot, error) {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return ServiceSnapshot{}, err
	}
	defer release()
	row, err := s.serviceByID(ctx, input.ID)
	if err != nil {
		return ServiceSnapshot{}, err
	}
	row.Provider, row.Name, row.OfficialKey = input.Provider, input.Name, input.OfficialKey
	row.UpdatedAt = s.now()
	if err := s.lifecycle.UpdateService(ctx, row); err != nil {
		return ServiceSnapshot{}, err
	}
	return serviceSnapshot(row), nil
}

func (s *CatalogService) ArchiveService(ctx context.Context, serviceID string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.lifecycle.ArchiveService(ctx, serviceID, s.now())
}

func (s *CatalogService) RestoreService(ctx context.Context, serviceID string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	row, err := s.serviceByID(ctx, serviceID)
	if err != nil {
		return err
	}
	row.ArchivedAt = nil
	row.UpdatedAt = s.now()
	return s.lifecycle.UpdateService(ctx, row)
}

func (s *CatalogService) CreateServiceIdentifierMapping(ctx context.Context, input ServiceIdentifierMappingInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	mapping, err := parseMappingInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterServiceIdentifierMapping(ctx, mapping)
}

func (s *CatalogService) UpdateServiceIdentifierMapping(ctx context.Context, input ServiceIdentifierMappingInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	mapping, err := parseMappingInput(input)
	if err != nil {
		return err
	}
	rows, err := s.lifecycle.ListServiceIdentifierMappings(ctx, "", "")
	if err != nil {
		return err
	}
	for _, existing := range rows {
		if existing.ID == mapping.ID {
			mapping.CreatedAt = existing.CreatedAt
			return s.lifecycle.UpdateServiceIdentifierMapping(ctx, mapping)
		}
	}
	return errors.New("service identifier mapping was not found")
}

func (s *CatalogService) CreateLimitDefinition(ctx context.Context, input LimitDefinitionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	definition, err := parseLimitDefinitionInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterLimitDefinition(ctx, definition)
}
func (s *CatalogService) UpdateLimitDefinition(ctx context.Context, input LimitDefinitionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	definition, err := parseLimitDefinitionInput(input)
	if err != nil {
		return err
	}
	rows, err := s.lifecycle.ListLimitDefinitions(ctx, true)
	if err != nil {
		return err
	}
	for _, existing := range rows {
		if existing.ID == definition.ID {
			definition.CreatedAt = existing.CreatedAt
			definition.ArchivedAt = existing.ArchivedAt
			if definition.BillingConfirmation == "" {
				definition.BillingConfirmation = existing.BillingConfirmation
			}
			return s.usecase.EditLimitDefinition(ctx, definition)
		}
	}
	return errors.New("limit definition was not found")
}
func (s *CatalogService) SetBillingConfirmation(ctx context.Context, definitionID, confirmation string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.lifecycle.SetBillingConfirmation(ctx, definitionID, domain.BillingConfirmation(confirmation), s.now())
}
func (s *CatalogService) CreatePlan(ctx context.Context, input PlanInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	plan, err := parsePlanInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterPlan(ctx, plan)
}
func (s *CatalogService) UpdatePlan(ctx context.Context, input PlanInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	plan, err := parsePlanInput(input)
	if err != nil {
		return err
	}
	rows, err := s.lifecycle.ListPlans(ctx, "", true)
	if err != nil {
		return err
	}
	for _, existing := range rows {
		if existing.ID == plan.ID {
			plan.CreatedAt = existing.CreatedAt
			plan.ArchivedAt = existing.ArchivedAt
			plan.IsBaseline = existing.IsBaseline
			return s.usecase.EditPlan(ctx, plan)
		}
	}
	return errors.New("plan was not found")
}
func (s *CatalogService) SetBaselinePlan(ctx context.Context, serviceID, planID string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.lifecycle.SetBaselinePlan(ctx, serviceID, planID, s.now())
}
func (s *CatalogService) CreatePlanVersion(ctx context.Context, input PlanVersionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	version, err := parsePlanVersionInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterPlanVersion(ctx, version)
}
func (s *CatalogService) CreatePlanLimitRule(ctx context.Context, input PlanLimitRuleInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	rule, err := parsePlanLimitRuleInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterPlanLimitRule(ctx, rule)
}
func (s *CatalogService) CreateStandardPrice(ctx context.Context, input StandardPriceInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	price, err := parseStandardPriceInput(input)
	if err != nil {
		return err
	}
	return s.usecase.RegisterStandardPrice(ctx, price)
}

func (s *CatalogService) UpdateStandardPrice(ctx context.Context, input StandardPriceInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	price, err := parseStandardPriceInput(input)
	if err != nil {
		return err
	}
	rows, err := s.lifecycle.ListStandardPrices(ctx, "")
	if err != nil {
		return err
	}
	for _, existing := range rows {
		if existing.ID == price.ID {
			price.CreatedAt = existing.CreatedAt
			return s.usecase.EditStandardPrice(ctx, price)
		}
	}
	return errors.New("standard price was not found")
}

func (s *CatalogService) ConfirmIdentificationCandidate(ctx context.Context, input CandidateDecisionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.usecase.ConfirmCandidate(ctx, input.CandidateID, input.ServiceID, input.PlanID)
}
func (s *CatalogService) RejectIdentificationCandidate(ctx context.Context, candidateID string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.usecase.RejectCandidate(ctx, candidateID)
}
func (s *CatalogService) ReleaseIdentificationCandidate(ctx context.Context, candidateID string) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.usecase.ReleaseCandidate(ctx, candidateID)
}
func (s *CatalogService) CorrectIdentificationCandidate(ctx context.Context, input CandidateCorrectionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.usecase.CorrectCandidate(ctx, input.CandidateID, input.RawLimitServiceIdentifier, input.RawReportedPlanName)
}
func (s *CatalogService) SplitIdentificationCandidate(ctx context.Context, input CandidateSplitInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	candidate := domain.IdentificationCandidate{RawLimitServiceIdentifier: input.RawLimitServiceIdentifier, RawReportedPlanName: input.RawReportedPlanName}
	return s.usecase.SplitCandidate(ctx, input.SourceCandidateID, candidate, input.ObservationIDs...)
}
func (s *CatalogService) DecideLabelChangeCandidate(ctx context.Context, input LabelChangeDecisionInput) error {
	release, err := acquireEdit(ctx, s.gate)
	if err != nil {
		return err
	}
	defer release()
	return s.usecase.DecideLimitLabelChangeCandidate(ctx, input.CandidateID, domain.LabelChangeState(input.State), input.LimitDefinitionID)
}

func (s *CatalogService) serviceByID(ctx context.Context, id string) (domain.Service, error) {
	if strings.TrimSpace(id) == "" {
		return domain.Service{}, errors.New("service ID is required")
	}
	rows, err := s.lifecycle.ListServices(ctx, true)
	if err != nil {
		return domain.Service{}, err
	}
	for _, row := range rows {
		if row.ID == id {
			return row, nil
		}
	}
	return domain.Service{}, errors.New("service was not found")
}

func (s *CatalogService) now() time.Time {
	return s.clock.Now().UTC()
}

func parseMappingInput(input ServiceIdentifierMappingInput) (domain.ServiceIdentifierMapping, error) {
	from, to, err := parsePeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.ServiceIdentifierMapping{}, err
	}
	return domain.ServiceIdentifierMapping{ID: input.ID, Kind: domain.ServiceIdentifierKind(input.Kind), RawIdentifier: input.RawIdentifier, ServiceID: input.ServiceID, ValidFrom: from, ValidTo: to}, nil
}
func parseLimitDefinitionInput(input LimitDefinitionInput) (domain.LimitDefinition, error) {
	return domain.LimitDefinition{ID: input.ID, ServiceID: input.ServiceID, CycleType: input.CycleType, Meaning: input.Meaning, Unit: input.Unit, BillingConfirmation: domain.BillingConfirmation(input.BillingConfirmation)}, nil
}
func parsePlanInput(input PlanInput) (domain.Plan, error) {
	return domain.Plan{ID: input.ID, ServiceID: input.ServiceID, Name: input.Name, IsBaseline: input.IsBaseline}, nil
}
func parsePlanVersionInput(input PlanVersionInput) (domain.PlanVersion, error) {
	from, to, err := parsePeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.PlanVersion{}, err
	}
	return domain.PlanVersion{ID: input.ID, PlanID: input.PlanID, Name: input.Name, ValidFrom: from, ValidTo: to, OfficialSourceURL: input.OfficialSourceURL}, nil
}
func parsePlanLimitRuleInput(input PlanLimitRuleInput) (domain.PlanLimitRule, error) {
	return domain.PlanLimitRule{ID: input.ID, PlanVersionID: input.PlanVersionID, LimitDefinitionID: input.LimitDefinitionID, Limit: input.Limit, Multiplier: input.Multiplier, OfficialSourceURL: input.OfficialSourceURL}, nil
}
func parseStandardPriceInput(input StandardPriceInput) (domain.StandardPrice, error) {
	from, to, err := parsePeriod(input.ValidFrom, input.ValidTo)
	if err != nil {
		return domain.StandardPrice{}, err
	}
	return domain.StandardPrice{ID: input.ID, PlanVersionID: input.PlanVersionID, USDMonthlyPerSeat: input.USDMonthlyPerSeat, SourceURL: input.SourceURL, ValidFrom: from, ValidTo: to}, nil
}

func parsePeriod(fromValue, toValue string) (time.Time, *time.Time, error) {
	if strings.TrimSpace(fromValue) == "" {
		return time.Time{}, nil, errors.New("period start is required")
	}
	from, err := time.Parse(time.RFC3339Nano, fromValue)
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("invalid period start: expected RFC3339 timestamp")
	}
	from = from.UTC()
	if strings.TrimSpace(toValue) == "" {
		return from, nil, nil
	}
	to, err := time.Parse(time.RFC3339Nano, toValue)
	if err != nil {
		return time.Time{}, nil, fmt.Errorf("invalid period end: expected RFC3339 timestamp")
	}
	to = to.UTC()
	return from, &to, nil
}

func formatOptional(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
func formatPtr(value *time.Time) string {
	if value == nil {
		return ""
	}
	return formatOptional(*value)
}
func serviceSnapshot(value domain.Service) ServiceSnapshot {
	return ServiceSnapshot{ID: value.ID, Provider: value.Provider, Name: value.Name, OfficialKey: value.OfficialKey, ArchivedAt: formatPtr(value.ArchivedAt), CreatedAt: formatOptional(value.CreatedAt), UpdatedAt: formatOptional(value.UpdatedAt)}
}
func mappingSnapshot(value domain.ServiceIdentifierMapping) ServiceIdentifierMappingSnapshot {
	return ServiceIdentifierMappingSnapshot{ID: value.ID, Kind: string(value.Kind), RawIdentifier: value.RawIdentifier, ServiceID: value.ServiceID, ValidFrom: formatOptional(value.ValidFrom), ValidTo: formatPtr(value.ValidTo), CreatedAt: formatOptional(value.CreatedAt)}
}
func limitDefinitionSnapshot(value domain.LimitDefinition) LimitDefinitionSnapshot {
	return LimitDefinitionSnapshot{ID: value.ID, ServiceID: value.ServiceID, CycleType: value.CycleType, Meaning: value.Meaning, Unit: value.Unit, BillingConfirmation: string(value.BillingConfirmation), ArchivedAt: formatPtr(value.ArchivedAt), CreatedAt: formatOptional(value.CreatedAt), UpdatedAt: formatOptional(value.UpdatedAt)}
}
func planSnapshot(value domain.Plan) PlanSnapshot {
	return PlanSnapshot{ID: value.ID, ServiceID: value.ServiceID, Name: value.Name, IsBaseline: value.IsBaseline, ArchivedAt: formatPtr(value.ArchivedAt), CreatedAt: formatOptional(value.CreatedAt), UpdatedAt: formatOptional(value.UpdatedAt)}
}
func planVersionSnapshot(value domain.PlanVersion) PlanVersionSnapshot {
	return PlanVersionSnapshot{ID: value.ID, PlanID: value.PlanID, Name: value.Name, ValidFrom: formatOptional(value.ValidFrom), ValidTo: formatPtr(value.ValidTo), OfficialSourceURL: value.OfficialSourceURL, CreatedAt: formatOptional(value.CreatedAt)}
}
func planLimitRuleSnapshot(value domain.PlanLimitRule) PlanLimitRuleSnapshot {
	return PlanLimitRuleSnapshot{ID: value.ID, PlanVersionID: value.PlanVersionID, LimitDefinitionID: value.LimitDefinitionID, Limit: value.Limit, Multiplier: value.Multiplier, OfficialSourceURL: value.OfficialSourceURL, CreatedAt: formatOptional(value.CreatedAt)}
}
func standardPriceSnapshot(value domain.StandardPrice) StandardPriceSnapshot {
	return StandardPriceSnapshot{ID: value.ID, PlanVersionID: value.PlanVersionID, USDMonthlyPerSeat: value.USDMonthlyPerSeat, SourceURL: value.SourceURL, ValidFrom: formatOptional(value.ValidFrom), ValidTo: formatPtr(value.ValidTo), CreatedAt: formatOptional(value.CreatedAt)}
}
func candidateSnapshot(value domain.IdentificationCandidate) IdentificationCandidateSnapshot {
	return IdentificationCandidateSnapshot{ID: value.ID, RawLimitServiceIdentifier: value.RawLimitServiceIdentifier, RawReportedPlanName: value.RawReportedPlanName, State: string(value.State), ServiceID: ptrString(value.ServiceID), PlanID: ptrString(value.PlanID), FirstObservedAt: formatPtr(value.FirstObservedAt), LastObservedAt: formatPtr(value.LastObservedAt), CreatedAt: formatOptional(value.CreatedAt), UpdatedAt: formatOptional(value.UpdatedAt), Observations: []CandidateObservationSnapshot{}}
}
func labelCandidateSnapshot(value domain.LimitLabelChangeCandidate) LabelChangeCandidateSnapshot {
	return LabelChangeCandidateSnapshot{ID: value.ID, HubID: value.HubID, DeviceRecordKey: value.DeviceRecordKey, HubAccountKey: value.HubAccountKey, RawLimitServiceIdentifier: value.RawLimitServiceIdentifier, NormalizedKind: value.NormalizedKind, NormalizedMetric: value.NormalizedMetric, OldLabel: value.OldLabel, NewLabel: value.NewLabel, State: string(value.State), LimitDefinitionID: ptrString(value.LimitDefinitionID), FirstObservedAt: formatPtr(value.FirstObservedAt), LastObservedAt: formatPtr(value.LastObservedAt), CreatedAt: formatOptional(value.CreatedAt), UpdatedAt: formatOptional(value.UpdatedAt), Windows: []LabelChangeWindowSnapshot{}}
}
func ptrString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
