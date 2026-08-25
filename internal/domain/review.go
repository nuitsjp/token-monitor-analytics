package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// ReviewKind identifies one read-only M04 item. The values intentionally
// follow the canonical state vocabulary instead of introducing UI-specific
// categories.
type ReviewKind string

const (
	ReviewKindIdentificationCandidate  ReviewKind = "identification_candidate"
	ReviewKindHubAccountCandidate      ReviewKind = "hub_account_candidate"
	ReviewKindUsageCostUnassociated    ReviewKind = "usage_cost_unassociated"
	ReviewKindUsageLimitUnassociated   ReviewKind = "usage_limit_unassociated"
	ReviewKindLabelChange              ReviewKind = "label_change"
	ReviewKindBillingMonthly           ReviewKind = "billing_monthly"
	ReviewKindPlanHistoryInconsistency ReviewKind = "plan_history_inconsistency"
	ReviewKindCompleteness             ReviewKind = "completeness"
	ReviewKindMissingAccountKey        ReviewKind = "missing_account_key"
	ReviewKindCostDedupeConflict       ReviewKind = "cost_dedupe_conflict"
	ReviewKindLimitDedupeConflict      ReviewKind = "limit_dedupe_conflict"
)

type ReviewState string

const (
	ReviewStateUnconfirmed            ReviewState = "unconfirmed"
	ReviewStateArchivedReconfirmation ReviewState = "archived_reconfirmation"
	ReviewStateMissing                ReviewState = "missing"
	ReviewStateActive                 ReviewState = "active"
	ReviewStateConflict               ReviewState = "conflict"
)

type ReviewImpact string

const (
	ReviewImpactCurrentCalculation            ReviewImpact = "current_calculation_impact"
	ReviewImpactCalculationIntervalImpossible ReviewImpact = "calculation_interval_impossible"
	ReviewImpactCurrentNoImpact               ReviewImpact = "current_no_impact"
)

// ReviewCurrentAssociation is the non-secret, human-readable association
// active at the review item's last observed time. It intentionally contains
// no internal identifiers.
type ReviewCurrentAssociation struct {
	LogicalAccountDisplayName string
	LimitMeaning              string
	PlanVersionName           string
	AssociationValidFrom      *time.Time
	AssociationValidTo        *time.Time
	PlanValidFrom             *time.Time
	PlanValidTo               *time.Time
}

// ReviewItem contains evidence and navigation identifiers only. It has no raw
// response body, credentials, or other secret-bearing fields.
type ReviewItem struct {
	ID                        string
	Kind                      ReviewKind
	State                     ReviewState
	Impact                    ReviewImpact
	HubID                     string
	SourceID                  string
	TargetID                  string
	Target                    string
	RawLimitServiceIdentifier string
	RawReportedPlanName       string
	AccountKey                string
	AccountDisplayName        string
	WorkspaceName             string
	DeviceName                string
	FirstObservedAt           time.Time
	LastObservedAt            time.Time
	TargetPeriodStart         *time.Time
	TargetPeriodEnd           *time.Time
	Count                     int
	EvidenceIDs               []string
	EstimationExclusionReason string
	CurrentAssociation        *ReviewCurrentAssociation
}

type ReviewFilter struct {
	Cursor string
	Limit  int
	From   *time.Time
	To     *time.Time
	Kind   ReviewKind
	State  ReviewState
	Impact ReviewImpact
	HubID  string
}

type ReviewPage struct {
	Items      []ReviewItem
	NextCursor string
	HasMore    bool
}

func (f ReviewFilter) Validate() error {
	if f.Limit < 0 {
		return errors.New("review limit cannot be negative")
	}
	if f.From != nil && f.To != nil && !f.From.Before(*f.To) {
		return errors.New("review date range must be half-open and ordered")
	}
	if f.Kind != "" && !validReviewKind(f.Kind) {
		return fmt.Errorf("unknown review kind %q", f.Kind)
	}
	if f.State != "" && !validReviewState(f.State) {
		return fmt.Errorf("unknown review state %q", f.State)
	}
	if f.Impact != "" && !validReviewImpact(f.Impact) {
		return fmt.Errorf("unknown review impact %q", f.Impact)
	}
	if strings.TrimSpace(f.HubID) != f.HubID {
		return errors.New("review Hub ID must not have surrounding whitespace")
	}
	return nil
}

func (i ReviewItem) Validate() error {
	if strings.TrimSpace(i.ID) == "" {
		return errors.New("review item ID is required")
	}
	if !validReviewKind(i.Kind) {
		return fmt.Errorf("unknown review kind %q", i.Kind)
	}
	if !validReviewState(i.State) {
		return fmt.Errorf("unknown review state %q", i.State)
	}
	if !validReviewImpact(i.Impact) {
		return fmt.Errorf("unknown review impact %q", i.Impact)
	}
	if i.FirstObservedAt.IsZero() || i.LastObservedAt.IsZero() || i.LastObservedAt.Before(i.FirstObservedAt) {
		return errors.New("review observation bounds are required and ordered")
	}
	if i.Count < 1 {
		return errors.New("review item count must be positive")
	}
	return nil
}

func validReviewKind(value ReviewKind) bool {
	switch value {
	case ReviewKindIdentificationCandidate, ReviewKindHubAccountCandidate,
		ReviewKindUsageCostUnassociated, ReviewKindUsageLimitUnassociated,
		ReviewKindLabelChange, ReviewKindBillingMonthly,
		ReviewKindPlanHistoryInconsistency, ReviewKindCompleteness,
		ReviewKindMissingAccountKey, ReviewKindCostDedupeConflict,
		ReviewKindLimitDedupeConflict:
		return true
	default:
		return false
	}
}

func validReviewState(value ReviewState) bool {
	switch value {
	case ReviewStateUnconfirmed, ReviewStateArchivedReconfirmation,
		ReviewStateMissing, ReviewStateActive, ReviewStateConflict:
		return true
	default:
		return false
	}
}

func validReviewImpact(value ReviewImpact) bool {
	switch value {
	case ReviewImpactCurrentCalculation, ReviewImpactCalculationIntervalImpossible,
		ReviewImpactCurrentNoImpact:
		return true
	default:
		return false
	}
}
