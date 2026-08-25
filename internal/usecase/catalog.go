package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

// CatalogStore is the narrow port used by catalog commands. The SQLite
// adapter owns the transaction, audit record, and recalculation request.
type CatalogStore interface {
	CreateService(context.Context, domain.Service) error
	CreateServiceIdentifierMapping(context.Context, domain.ServiceIdentifierMapping) error
	CreateLimitDefinition(context.Context, domain.LimitDefinition) error
	UpdateLimitDefinition(context.Context, domain.LimitDefinition) error
	ArchiveLimitDefinition(context.Context, string, time.Time) error
	CreatePlan(context.Context, domain.Plan) error
	UpdatePlan(context.Context, domain.Plan) error
	ArchivePlan(context.Context, string, time.Time) error
	CreatePlanVersion(context.Context, domain.PlanVersion) error
	CreatePlanLimitRule(context.Context, domain.PlanLimitRule) error
	CreateStandardPrice(context.Context, domain.StandardPrice) error
	CreateIdentificationCandidate(context.Context, domain.IdentificationCandidate) error
	ConfirmIdentificationCandidate(context.Context, string, string, string, time.Time) error
	RejectIdentificationCandidate(context.Context, string, time.Time) error
	ReleaseIdentificationCandidate(context.Context, string, time.Time) error
	UpdateIdentificationCandidate(context.Context, string, string, string, time.Time) error
	SplitIdentificationCandidate(context.Context, string, domain.IdentificationCandidate, ...string) error
	CreateLimitLabelChangeCandidate(context.Context, domain.LimitLabelChangeCandidate) error
	AddLimitLabelChangeWindow(context.Context, domain.LimitLabelChangeWindow) error
	DecideLimitLabelChangeCandidate(context.Context, string, domain.LabelChangeState, string, time.Time) error
}

type CatalogUsecase struct {
	store CatalogStore
	clock Clock
	ids   IDGenerator
}

func NewCatalogUsecase(store CatalogStore, clock Clock, ids IDGenerator) (*CatalogUsecase, error) {
	if store == nil || clock == nil || ids == nil {
		return nil, errors.New("catalog usecase dependencies are required")
	}
	return &CatalogUsecase{store: store, clock: clock, ids: ids}, nil
}

func (u *CatalogUsecase) RegisterService(ctx context.Context, provider, name, officialKey string) (domain.Service, error) {
	now := u.clock.Now().UTC()
	service := domain.Service{ID: u.ids.New(), Provider: provider, Name: name, OfficialKey: officialKey, CreatedAt: now, UpdatedAt: now}
	if err := service.Validate(); err != nil {
		return domain.Service{}, err
	}
	if err := u.store.CreateService(ctx, service); err != nil {
		return domain.Service{}, fmt.Errorf("register service: %w", err)
	}
	return service, nil
}

func (u *CatalogUsecase) RegisterServiceIdentifierMapping(ctx context.Context, mapping domain.ServiceIdentifierMapping) error {
	if mapping.ID == "" {
		mapping.ID = u.ids.New()
	}
	if mapping.CreatedAt.IsZero() {
		mapping.CreatedAt = u.clock.Now().UTC()
	}
	if err := mapping.Validate(); err != nil {
		return err
	}
	if err := u.store.CreateServiceIdentifierMapping(ctx, mapping); err != nil {
		return fmt.Errorf("register service identifier mapping: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterLimitDefinition(ctx context.Context, definition domain.LimitDefinition) error {
	if definition.ID == "" {
		definition.ID = u.ids.New()
	}
	now := u.clock.Now().UTC()
	if definition.CreatedAt.IsZero() {
		definition.CreatedAt = now
	}
	if definition.UpdatedAt.IsZero() {
		definition.UpdatedAt = now
	}
	if definition.BillingConfirmation == "" {
		if definition.CycleType == "billing" {
			definition.BillingConfirmation = domain.BillingUnconfirmed
		} else {
			definition.BillingConfirmation = domain.BillingNotApplicable
		}
	}
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := u.store.CreateLimitDefinition(ctx, definition); err != nil {
		return fmt.Errorf("register limit definition: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterPlan(ctx context.Context, plan domain.Plan) error {
	if plan.ID == "" {
		plan.ID = u.ids.New()
	}
	now := u.clock.Now().UTC()
	if plan.CreatedAt.IsZero() {
		plan.CreatedAt = now
	}
	if plan.UpdatedAt.IsZero() {
		plan.UpdatedAt = now
	}
	if err := plan.Validate(); err != nil {
		return err
	}
	if err := u.store.CreatePlan(ctx, plan); err != nil {
		return fmt.Errorf("register plan: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) EditLimitDefinition(ctx context.Context, definition domain.LimitDefinition) error {
	if definition.UpdatedAt.IsZero() {
		definition.UpdatedAt = u.clock.Now().UTC()
	}
	if definition.BillingConfirmation == "" {
		if definition.CycleType == "billing" {
			definition.BillingConfirmation = domain.BillingUnconfirmed
		} else {
			definition.BillingConfirmation = domain.BillingNotApplicable
		}
	}
	if err := definition.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdateLimitDefinition(ctx, definition); err != nil {
		return fmt.Errorf("edit limit definition: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) ArchiveLimitDefinition(ctx context.Context, definitionID string) error {
	if err := u.store.ArchiveLimitDefinition(ctx, definitionID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("archive limit definition: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) EditPlan(ctx context.Context, plan domain.Plan) error {
	if plan.UpdatedAt.IsZero() {
		plan.UpdatedAt = u.clock.Now().UTC()
	}
	if err := plan.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdatePlan(ctx, plan); err != nil {
		return fmt.Errorf("edit plan: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) ArchivePlan(ctx context.Context, planID string) error {
	if err := u.store.ArchivePlan(ctx, planID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("archive plan: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterPlanVersion(ctx context.Context, version domain.PlanVersion) error {
	if version.ID == "" {
		version.ID = u.ids.New()
	}
	if version.CreatedAt.IsZero() {
		version.CreatedAt = u.clock.Now().UTC()
	}
	if err := version.Validate(); err != nil {
		return err
	}
	if err := u.store.CreatePlanVersion(ctx, version); err != nil {
		return fmt.Errorf("register plan version: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterPlanLimitRule(ctx context.Context, rule domain.PlanLimitRule) error {
	if rule.ID == "" {
		rule.ID = u.ids.New()
	}
	if rule.CreatedAt.IsZero() {
		rule.CreatedAt = u.clock.Now().UTC()
	}
	if err := rule.Validate(); err != nil {
		return err
	}
	if err := u.store.CreatePlanLimitRule(ctx, rule); err != nil {
		return fmt.Errorf("register plan limit rule: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterStandardPrice(ctx context.Context, price domain.StandardPrice) error {
	if price.ID == "" {
		price.ID = u.ids.New()
	}
	if price.CreatedAt.IsZero() {
		price.CreatedAt = u.clock.Now().UTC()
	}
	if err := price.Validate(); err != nil {
		return err
	}
	if err := u.store.CreateStandardPrice(ctx, price); err != nil {
		return fmt.Errorf("register standard price: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) ConfirmCandidate(ctx context.Context, candidateID, serviceID, planID string) error {
	if err := u.store.ConfirmIdentificationCandidate(ctx, candidateID, serviceID, planID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("confirm identification candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RejectCandidate(ctx context.Context, candidateID string) error {
	if err := u.store.RejectIdentificationCandidate(ctx, candidateID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("reject identification candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) ReleaseCandidate(ctx context.Context, candidateID string) error {
	if err := u.store.ReleaseIdentificationCandidate(ctx, candidateID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("release identification candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) CorrectCandidate(ctx context.Context, candidateID, rawLimitIdentifier, rawPlanName string) error {
	if err := u.store.UpdateIdentificationCandidate(ctx, candidateID, rawLimitIdentifier, rawPlanName, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("correct identification candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) SplitCandidate(ctx context.Context, sourceCandidateID string, candidate domain.IdentificationCandidate, observationIDs ...string) error {
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
	if err := u.store.SplitIdentificationCandidate(ctx, sourceCandidateID, candidate, observationIDs...); err != nil {
		return fmt.Errorf("split identification candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) RegisterLimitLabelChangeCandidate(ctx context.Context, candidate domain.LimitLabelChangeCandidate) error {
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
		candidate.State = domain.LabelChangeUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	if err := u.store.CreateLimitLabelChangeCandidate(ctx, candidate); err != nil {
		return fmt.Errorf("register limit label change candidate: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) AddLimitLabelChangeWindow(ctx context.Context, window domain.LimitLabelChangeWindow) error {
	if window.ID == "" {
		window.ID = u.ids.New()
	}
	if window.ObservedAt.IsZero() {
		window.ObservedAt = u.clock.Now().UTC()
	}
	if err := window.Validate(); err != nil {
		return err
	}
	if err := u.store.AddLimitLabelChangeWindow(ctx, window); err != nil {
		return fmt.Errorf("add limit label change window: %w", err)
	}
	return nil
}

func (u *CatalogUsecase) DecideLimitLabelChangeCandidate(ctx context.Context, candidateID string, state domain.LabelChangeState, limitDefinitionID string) error {
	if err := u.store.DecideLimitLabelChangeCandidate(ctx, candidateID, state, limitDefinitionID, u.clock.Now().UTC()); err != nil {
		return fmt.Errorf("decide limit label change candidate: %w", err)
	}
	return nil
}
