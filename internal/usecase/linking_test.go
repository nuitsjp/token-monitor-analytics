package usecase

import (
	"context"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type linkingTestClock struct{ now time.Time }

func (c linkingTestClock) Now() time.Time { return c.now }

type linkingTestIDs struct{ next string }

func (g linkingTestIDs) New() string { return g.next }

type linkingTestStore struct {
	costSource             domain.UsageCostSource
	costAssociation        domain.UsageCostAssociation
	updatedAssociation     domain.UsageCostAssociation
	preview                domain.ImpactPreview
	costSourceCreates      int
	costAssociationCreates int
	associationUpdates     int
	previewCalls           int
}

func (s *linkingTestStore) CreateUsageCostSource(_ context.Context, source domain.UsageCostSource) error {
	s.costSourceCreates++
	s.costSource = source
	return nil
}
func (s *linkingTestStore) CreateUsageLimitSource(context.Context, domain.UsageLimitSource) error {
	return nil
}
func (s *linkingTestStore) CreateUsageCostAssociation(_ context.Context, association domain.UsageCostAssociation) error {
	s.costAssociationCreates++
	s.costAssociation = association
	return nil
}
func (s *linkingTestStore) CreateUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) error {
	return nil
}
func (s *linkingTestStore) UpdateUsageCostAssociation(_ context.Context, association domain.UsageCostAssociation) error {
	s.associationUpdates++
	s.updatedAssociation = association
	return nil
}
func (s *linkingTestStore) UpdateUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) error {
	return nil
}
func (s *linkingTestStore) CreateUsageCostSourceCompleteness(context.Context, domain.UsageCostSourceCompleteness) error {
	return nil
}
func (s *linkingTestStore) UpdateUsageCostSourceCompleteness(context.Context, domain.UsageCostSourceCompleteness) error {
	return nil
}
func (s *linkingTestStore) ConfirmHubSwitch(context.Context, domain.HubSwitch) error { return nil }
func (s *linkingTestStore) PreviewUsageCostAssociation(_ context.Context, association domain.UsageCostAssociation) (domain.ImpactPreview, error) {
	s.previewCalls++
	s.preview.SourceID = association.UsageCostSourceID
	return s.preview, nil
}
func (s *linkingTestStore) PreviewUsageLimitAssociation(context.Context, domain.UsageLimitAssociation) (domain.ImpactPreview, error) {
	s.previewCalls++
	return s.preview, nil
}

func TestT023LinkingUsecaseInjectsIDsTimesAndValidatesBeforeStore(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	store := &linkingTestStore{}
	uc, err := NewLinkingUsecase(store, linkingTestClock{now: now}, linkingTestIDs{next: "injected-id"})
	if err != nil {
		t.Fatal(err)
	}
	source, err := uc.RegisterUsageCostSource(context.Background(), domain.UsageCostSource{HubID: "hub", DeviceID: "device", RawServiceIdentifier: "raw"})
	if err != nil {
		t.Fatal(err)
	}
	if source.ID != "injected-id" || !source.CreatedAt.Equal(now) || store.costSourceCreates != 1 {
		t.Fatalf("source injection = %#v, store creates = %d", source, store.costSourceCreates)
	}
	if _, err := uc.RegisterUsageCostSource(context.Background(), domain.UsageCostSource{HubID: "hub", DeviceID: "device"}); err == nil {
		t.Fatal("invalid source reached the store")
	}
	if store.costSourceCreates != 1 {
		t.Fatalf("invalid source changed store calls: %d", store.costSourceCreates)
	}
}

func TestT023LinkingUsecasePreviewIsReadOnlyAndUpdateInjectsTime(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	store := &linkingTestStore{preview: domain.ImpactPreview{AffectedObservationIDs: []string{"observation"}}}
	uc, err := NewLinkingUsecase(store, linkingTestClock{now: now}, linkingTestIDs{next: "preview-id"})
	if err != nil {
		t.Fatal(err)
	}
	end := now.Add(time.Hour)
	association := domain.UsageCostAssociation{UsageCostSourceID: "source", LogicalAccountID: "account", ValidFrom: now, ValidTo: &end}
	preview, err := uc.PreviewUsageCostAssociation(context.Background(), association)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.AffectedObservationIDs) != 1 || store.previewCalls != 1 || store.costAssociationCreates != 0 || store.associationUpdates != 0 {
		t.Fatalf("preview side effects: preview=%#v store=%#v", preview, store)
	}
	if err := uc.UpdateUsageCostAssociation(context.Background(), domain.UsageCostAssociation{ID: "existing", UsageCostSourceID: "source", LogicalAccountID: "account", ValidFrom: now, ValidTo: &end, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if store.associationUpdates != 1 || store.updatedAssociation.ID != "existing" || !store.updatedAssociation.UpdatedAt.Equal(now) {
		t.Fatalf("update injection = %#v", store.updatedAssociation)
	}
}
