package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// HubAccountCandidateState is the user decision for an observation-side
// account. A candidate is never inferred from a display name or e-mail.
type HubAccountCandidateState string

const (
	HubAccountCandidateUnconfirmed            HubAccountCandidateState = "unconfirmed"
	HubAccountCandidateAssociated             HubAccountCandidateState = "associated"
	HubAccountCandidateRejected               HubAccountCandidateState = "rejected"
	HubAccountCandidateArchivedReconfirmation HubAccountCandidateState = "archived_reconfirmation"
)

// HubAccountCandidate identifies one non-empty accountKey reported by one Hub
// for one confirmed service. Display fields are evidence only and are not
// identity keys.
type HubAccountCandidate struct {
	ID               string
	HubID            string
	ServiceID        string
	AccountKey       string
	AccountKeyKind   string
	DisplayName      string
	Email            string
	WorkspaceName    string
	DeviceName       string
	State            HubAccountCandidateState
	LogicalAccountID *string
	FirstObservedAt  *time.Time
	LastObservedAt   *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// LogicalAccount is the cross-Hub analysis identity for one service.
type LogicalAccount struct {
	ID          string
	ServiceID   string
	DisplayName string
	ArchivedAt  *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// PlanHistory records the plan version explicitly selected for a logical
// account over a UTC half-open interval.
type PlanHistory struct {
	ID               string
	LogicalAccountID string
	PlanVersionID    string
	ValidFrom        time.Time
	ValidTo          *time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

func (c HubAccountCandidate) Validate() error {
	for value, label := range map[string]string{
		c.ID: "Hub account candidate ID", c.HubID: "Hub ID", c.ServiceID: "service ID", c.AccountKey: "account key",
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	state := c.State
	if state == "" {
		state = HubAccountCandidateUnconfirmed
	}
	switch state {
	case HubAccountCandidateUnconfirmed, HubAccountCandidateRejected:
		if c.LogicalAccountID != nil && strings.TrimSpace(*c.LogicalAccountID) != "" {
			return errors.New("unconfirmed or rejected hub account candidate cannot reference a logical account")
		}
	case HubAccountCandidateAssociated, HubAccountCandidateArchivedReconfirmation:
		if c.LogicalAccountID == nil || strings.TrimSpace(*c.LogicalAccountID) == "" {
			return errors.New("associated hub account candidate requires a logical account")
		}
	default:
		return fmt.Errorf("unknown Hub account candidate state %q", state)
	}
	if c.FirstObservedAt != nil && c.LastObservedAt != nil && c.LastObservedAt.Before(*c.FirstObservedAt) {
		return errors.New("hub account candidate observation interval is reversed")
	}
	if c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() {
		return errors.New("hub account candidate timestamps are required")
	}
	return nil
}

func (a LogicalAccount) Validate() error {
	for value, label := range map[string]string{a.ID: "logical account ID", a.ServiceID: "service ID", a.DisplayName: "logical account display name"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if a.CreatedAt.IsZero() || a.UpdatedAt.IsZero() {
		return errors.New("logical account timestamps are required")
	}
	return nil
}

func (h PlanHistory) Validate() error {
	for value, label := range map[string]string{h.ID: "plan history ID", h.LogicalAccountID: "logical account ID", h.PlanVersionID: "plan version ID"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if err := ValidatePeriod(h.ValidFrom, h.ValidTo); err != nil {
		return fmt.Errorf("plan history: %w", err)
	}
	if h.CreatedAt.IsZero() || h.UpdatedAt.IsZero() {
		return errors.New("plan history timestamps are required")
	}
	return nil
}
