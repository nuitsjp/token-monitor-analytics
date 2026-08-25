package usecase

import (
	"context"
	"errors"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

// LinkingStore is the narrow T-023 output port. The SQLite adapter owns the
// transaction containing the relation, audit row, and recalculation request.
type LinkingStore interface {
	CreateUsageCostSource(context.Context, domain.UsageCostSource) error
	CreateUsageLimitSource(context.Context, domain.UsageLimitSource) error
	CreateUsageCostAssociation(context.Context, domain.UsageCostAssociation) error
	CreateUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) error
	UpdateUsageCostAssociation(context.Context, domain.UsageCostAssociation) error
	UpdateUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) error
	CreateUsageCostSourceCompleteness(context.Context, domain.UsageCostSourceCompleteness) error
	UpdateUsageCostSourceCompleteness(context.Context, domain.UsageCostSourceCompleteness) error
	ConfirmHubSwitch(context.Context, domain.HubSwitch) error
	PreviewUsageCostAssociation(context.Context, domain.UsageCostAssociation) (domain.ImpactPreview, error)
	PreviewUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) (domain.ImpactPreview, error)
	PreviewUsageCostSourceCompleteness(context.Context, domain.UsageCostSourceCompleteness) (domain.ImpactPreview, error)
	PreviewHubSwitch(context.Context, domain.HubSwitch) (domain.ImpactPreview, error)
}

type LinkingUsecase struct {
	store LinkingStore
	clock Clock
	ids   IDGenerator
}

func NewLinkingUsecase(store LinkingStore, clock Clock, ids IDGenerator) (*LinkingUsecase, error) {
	if store == nil || clock == nil || ids == nil {
		return nil, errors.New("linking usecase dependencies are required")
	}
	return &LinkingUsecase{store: store, clock: clock, ids: ids}, nil
}

func (u *LinkingUsecase) RegisterUsageCostSource(ctx context.Context, source domain.UsageCostSource) (domain.UsageCostSource, error) {
	if source.ID == "" {
		source.ID = u.ids.New()
	}
	if source.CreatedAt.IsZero() {
		source.CreatedAt = u.clock.Now().UTC()
	}
	if err := source.Validate(); err != nil {
		return domain.UsageCostSource{}, err
	}
	if err := u.store.CreateUsageCostSource(ctx, source); err != nil {
		return domain.UsageCostSource{}, fmt.Errorf("register usage cost source: %w", err)
	}
	return source, nil
}

func (u *LinkingUsecase) RegisterUsageLimitSource(ctx context.Context, source domain.UsageLimitSource) (domain.UsageLimitSource, error) {
	if source.ID == "" {
		source.ID = u.ids.New()
	}
	if source.CreatedAt.IsZero() {
		source.CreatedAt = u.clock.Now().UTC()
	}
	if err := source.Validate(); err != nil {
		return domain.UsageLimitSource{}, err
	}
	if err := u.store.CreateUsageLimitSource(ctx, source); err != nil {
		return domain.UsageLimitSource{}, fmt.Errorf("register usage limit source: %w", err)
	}
	return source, nil
}

func (u *LinkingUsecase) AssociateUsageCostSource(ctx context.Context, association domain.UsageCostAssociation) (domain.UsageCostAssociation, error) {
	association = u.prepareCostAssociation(association)
	if err := association.Validate(); err != nil {
		return domain.UsageCostAssociation{}, err
	}
	if err := u.store.CreateUsageCostAssociation(ctx, association); err != nil {
		return domain.UsageCostAssociation{}, fmt.Errorf("associate usage cost source: %w", err)
	}
	return association, nil
}

func (u *LinkingUsecase) AssociateUsageLimitSource(ctx context.Context, association domain.UsageLimitAssociation) (domain.UsageLimitAssociation, error) {
	association = u.prepareLimitAssociation(association)
	if err := association.Validate(); err != nil {
		return domain.UsageLimitAssociation{}, err
	}
	if err := u.store.CreateUsageLimitAssociation(ctx, association); err != nil {
		return domain.UsageLimitAssociation{}, fmt.Errorf("associate usage limit source: %w", err)
	}
	return association, nil
}

func (u *LinkingUsecase) UpdateUsageCostAssociation(ctx context.Context, association domain.UsageCostAssociation) error {
	association = u.prepareCostAssociation(association)
	if err := association.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdateUsageCostAssociation(ctx, association); err != nil {
		return fmt.Errorf("update usage cost association: %w", err)
	}
	return nil
}

func (u *LinkingUsecase) UpdateUsageLimitAssociation(ctx context.Context, association domain.UsageLimitAssociation) error {
	association = u.prepareLimitAssociation(association)
	if err := association.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdateUsageLimitAssociation(ctx, association); err != nil {
		return fmt.Errorf("update usage limit association: %w", err)
	}
	return nil
}

func (u *LinkingUsecase) ConfirmUsageCostSourceCompleteness(ctx context.Context, completeness domain.UsageCostSourceCompleteness) (domain.UsageCostSourceCompleteness, error) {
	if completeness.ID == "" {
		completeness.ID = u.ids.New()
	}
	if completeness.CreatedAt.IsZero() {
		completeness.CreatedAt = u.clock.Now().UTC()
	}
	if completeness.UpdatedAt.IsZero() {
		completeness.UpdatedAt = u.clock.Now().UTC()
	}
	if completeness.State == "" {
		completeness.State = domain.CompletenessUnconfirmed
	}
	if err := completeness.Validate(); err != nil {
		return domain.UsageCostSourceCompleteness{}, err
	}
	if err := u.store.CreateUsageCostSourceCompleteness(ctx, completeness); err != nil {
		return domain.UsageCostSourceCompleteness{}, fmt.Errorf("record usage cost source completeness: %w", err)
	}
	return completeness, nil
}

func (u *LinkingUsecase) UpdateUsageCostSourceCompleteness(ctx context.Context, completeness domain.UsageCostSourceCompleteness) error {
	if completeness.UpdatedAt.IsZero() {
		completeness.UpdatedAt = u.clock.Now().UTC()
	}
	if err := completeness.Validate(); err != nil {
		return err
	}
	if err := u.store.UpdateUsageCostSourceCompleteness(ctx, completeness); err != nil {
		return fmt.Errorf("update usage cost source completeness: %w", err)
	}
	return nil
}

func (u *LinkingUsecase) ConfirmHubSwitch(ctx context.Context, switchRecord domain.HubSwitch) (domain.HubSwitch, error) {
	if switchRecord.ID == "" {
		switchRecord.ID = u.ids.New()
	}
	if switchRecord.CreatedAt.IsZero() {
		switchRecord.CreatedAt = u.clock.Now().UTC()
	}
	if err := switchRecord.Validate(); err != nil {
		return domain.HubSwitch{}, err
	}
	if err := u.store.ConfirmHubSwitch(ctx, switchRecord); err != nil {
		return domain.HubSwitch{}, fmt.Errorf("confirm Hub switch: %w", err)
	}
	return switchRecord, nil
}

func (u *LinkingUsecase) PreviewUsageCostAssociation(ctx context.Context, association domain.UsageCostAssociation) (domain.ImpactPreview, error) {
	association = u.prepareCostAssociation(association)
	if err := association.Validate(); err != nil {
		return domain.ImpactPreview{}, err
	}
	return u.store.PreviewUsageCostAssociation(ctx, association)
}

func (u *LinkingUsecase) PreviewUsageLimitAssociation(ctx context.Context, association domain.UsageLimitAssociation) (domain.ImpactPreview, error) {
	association = u.prepareLimitAssociation(association)
	if err := association.Validate(); err != nil {
		return domain.ImpactPreview{}, err
	}
	return u.store.PreviewUsageLimitAssociation(ctx, association)
}

func (u *LinkingUsecase) PreviewUsageCostSourceCompleteness(ctx context.Context, completeness domain.UsageCostSourceCompleteness) (domain.ImpactPreview, error) {
	if completeness.ID == "" {
		completeness.ID = u.ids.New()
	}
	now := u.clock.Now().UTC()
	if completeness.CreatedAt.IsZero() {
		completeness.CreatedAt = now
	}
	if completeness.UpdatedAt.IsZero() {
		completeness.UpdatedAt = now
	}
	if completeness.State == "" {
		completeness.State = domain.CompletenessUnconfirmed
	}
	if err := completeness.Validate(); err != nil {
		return domain.ImpactPreview{}, err
	}
	return u.store.PreviewUsageCostSourceCompleteness(ctx, completeness)
}

func (u *LinkingUsecase) PreviewHubSwitch(ctx context.Context, switchRecord domain.HubSwitch) (domain.ImpactPreview, error) {
	if switchRecord.ID == "" {
		switchRecord.ID = u.ids.New()
	}
	if switchRecord.CreatedAt.IsZero() {
		switchRecord.CreatedAt = u.clock.Now().UTC()
	}
	if err := switchRecord.Validate(); err != nil {
		return domain.ImpactPreview{}, err
	}
	return u.store.PreviewHubSwitch(ctx, switchRecord)
}

func (u *LinkingUsecase) prepareCostAssociation(association domain.UsageCostAssociation) domain.UsageCostAssociation {
	now := u.clock.Now().UTC()
	if association.ID == "" {
		association.ID = u.ids.New()
	}
	if association.CreatedAt.IsZero() {
		association.CreatedAt = now
	}
	if association.UpdatedAt.IsZero() {
		association.UpdatedAt = now
	}
	association.ValidFrom = association.ValidFrom.UTC()
	if association.ValidTo != nil {
		value := association.ValidTo.UTC()
		association.ValidTo = &value
	}
	return association
}

func (u *LinkingUsecase) prepareLimitAssociation(association domain.UsageLimitAssociation) domain.UsageLimitAssociation {
	now := u.clock.Now().UTC()
	if association.ID == "" {
		association.ID = u.ids.New()
	}
	if association.CreatedAt.IsZero() {
		association.CreatedAt = now
	}
	if association.UpdatedAt.IsZero() {
		association.UpdatedAt = now
	}
	association.ValidFrom = association.ValidFrom.UTC()
	if association.ValidTo != nil {
		value := association.ValidTo.UTC()
		association.ValidTo = &value
	}
	return association
}
