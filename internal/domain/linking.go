package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// UsageCostSource is the immutable observation source identified by one Hub,
// one device record, and one raw cost service identifier.
type UsageCostSource struct {
	ID                   string
	HubID                string
	DeviceID             string
	RawServiceIdentifier string
	CreatedAt            time.Time
}

// UsageLimitSource is the immutable observation source identified by the
// complete limit observation key. AccountKey may be empty for an unconfirmed
// provider row; such a source cannot be linked to an account.
type UsageLimitSource struct {
	ID                   string
	HubID                string
	DeviceID             string
	AccountKey           string
	RawServiceIdentifier string
	WindowKey            string
	NormalizedKind       string
	NormalizedMetric     string
	NormalizedLabel      string
	CreatedAt            time.Time
}

// UsageCostAssociation maps a cost source to a logical account for a
// half-open period. The relation is intentionally n:n.
type UsageCostAssociation struct {
	ID                string
	UsageCostSourceID string
	LogicalAccountID  string
	ValidFrom         time.Time
	ValidTo           *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// UsageLimitAssociation maps one limit source to exactly one account and one
// limit definition for a half-open period.
type UsageLimitAssociation struct {
	ID                 string
	UsageLimitSourceID string
	LogicalAccountID   string
	LimitDefinitionID  string
	ValidFrom          time.Time
	ValidTo            *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type CompletenessState string

const (
	CompletenessUnconfirmed CompletenessState = "unconfirmed"
	CompletenessConfirmed   CompletenessState = "confirmed"
)

// UsageCostSourceCompleteness is an explicit user assertion about every
// activity participant in a source interval. ExcludedActivity is intentionally
// explicit: an empty list means the user confirmed that no excluded activity
// exists, not that the caller forgot to provide it.
type UsageCostSourceCompleteness struct {
	ID                string
	UsageCostSourceID string
	ValidFrom         time.Time
	ValidTo           *time.Time
	State             CompletenessState
	LogicalAccountIDs []string
	ExcludedActivity  []string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// HubSwitch records a user-confirmed handoff between two Hub device records.
// Matching names or device IDs alone are never enough to create this record.
type HubSwitch struct {
	ID                 string
	OldHubID           string
	OldDeviceID        string
	NewHubID           string
	NewDeviceID        string
	CollectionDeviceID string
	SwitchedAt         time.Time
	CreatedAt          time.Time
}

type ImpactInterval struct {
	Start time.Time
	End   time.Time
}

// ImpactPreview is read-only information shown before a relation or
// completeness change is committed.
type ImpactPreview struct {
	SourceID                       string
	SourceKind                     string
	AffectedSourceIDs              []string
	IntervalStart                  time.Time
	IntervalEnd                    time.Time
	AffectedObservationIDs         []string
	AffectedCalculationIntervalIDs []string
	AffectedCalculationIntervals   []ImpactInterval
	AffectedDerivedResultIDs       []string
}

func (s UsageCostSource) Validate() error {
	for value, label := range map[string]string{s.ID: "usage cost source ID", s.HubID: "Hub ID", s.DeviceID: "device ID", s.RawServiceIdentifier: "raw service identifier"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if s.CreatedAt.IsZero() {
		return errors.New("usage cost source creation time is required")
	}
	return nil
}

func (s UsageLimitSource) Validate() error {
	for value, label := range map[string]string{s.ID: "usage limit source ID", s.HubID: "Hub ID", s.DeviceID: "device ID", s.RawServiceIdentifier: "raw service identifier", s.WindowKey: "window key"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if s.CreatedAt.IsZero() {
		return errors.New("usage limit source creation time is required")
	}
	return nil
}

func (a UsageCostAssociation) Validate() error {
	for value, label := range map[string]string{a.ID: "usage cost association ID", a.UsageCostSourceID: "usage cost source ID", a.LogicalAccountID: "logical account ID"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if err := ValidatePeriod(a.ValidFrom, a.ValidTo); err != nil {
		return fmt.Errorf("usage cost association: %w", err)
	}
	if a.CreatedAt.IsZero() || a.UpdatedAt.IsZero() {
		return errors.New("usage cost association timestamps are required")
	}
	return nil
}

func (a UsageLimitAssociation) Validate() error {
	for value, label := range map[string]string{a.ID: "usage limit association ID", a.UsageLimitSourceID: "usage limit source ID", a.LogicalAccountID: "logical account ID", a.LimitDefinitionID: "limit definition ID"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if err := ValidatePeriod(a.ValidFrom, a.ValidTo); err != nil {
		return fmt.Errorf("usage limit association: %w", err)
	}
	if a.CreatedAt.IsZero() || a.UpdatedAt.IsZero() {
		return errors.New("usage limit association timestamps are required")
	}
	return nil
}

func (c UsageCostSourceCompleteness) Validate() error {
	if strings.TrimSpace(c.ID) == "" || strings.TrimSpace(c.UsageCostSourceID) == "" {
		return errors.New("usage cost source completeness has an empty required ID")
	}
	if err := ValidatePeriod(c.ValidFrom, c.ValidTo); err != nil {
		return fmt.Errorf("usage cost source completeness: %w", err)
	}
	if c.State == "" {
		c.State = CompletenessUnconfirmed
	}
	if c.State != CompletenessUnconfirmed && c.State != CompletenessConfirmed {
		return fmt.Errorf("unknown completeness state %q", c.State)
	}
	if c.State == CompletenessConfirmed && len(c.ExcludedActivity) != 0 {
		return errors.New("confirmed completeness cannot contain excluded activity")
	}
	if hasDuplicateOrEmpty(c.LogicalAccountIDs) || hasDuplicateOrEmpty(c.ExcludedActivity) {
		return errors.New("completeness participants must be unique and non-empty")
	}
	if c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() {
		return errors.New("usage cost source completeness timestamps are required")
	}
	return nil
}

func (s HubSwitch) Validate() error {
	for value, label := range map[string]string{s.ID: "Hub switch ID", s.OldHubID: "old Hub ID", s.OldDeviceID: "old device ID", s.NewHubID: "new Hub ID", s.NewDeviceID: "new device ID", s.CollectionDeviceID: "collection device ID"} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if s.OldHubID == s.NewHubID && s.OldDeviceID == s.NewDeviceID {
		return errors.New("hub switch must change the Hub device record")
	}
	if s.SwitchedAt.IsZero() || s.CreatedAt.IsZero() {
		return errors.New("hub switch timestamps are required")
	}
	return nil
}

func (c UsageCostSourceCompleteness) CanonicalJSON() (string, string, error) {
	if err := c.Validate(); err != nil {
		return "", "", err
	}
	accounts := append([]string(nil), c.LogicalAccountIDs...)
	excluded := append([]string(nil), c.ExcludedActivity...)
	if accounts == nil {
		accounts = []string{}
	}
	if excluded == nil {
		excluded = []string{}
	}
	sort.Strings(accounts)
	sort.Strings(excluded)
	a, err := json.Marshal(accounts)
	if err != nil {
		return "", "", fmt.Errorf("encode completeness accounts: %w", err)
	}
	e, err := json.Marshal(excluded)
	if err != nil {
		return "", "", fmt.Errorf("encode completeness exclusions: %w", err)
	}
	return string(a), string(e), nil
}

func hasDuplicateOrEmpty(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return true
		}
		if _, ok := seen[value]; ok {
			return true
		}
		seen[value] = struct{}{}
	}
	return false
}
