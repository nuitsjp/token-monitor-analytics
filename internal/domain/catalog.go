package domain

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"
)

// CandidateState is the user's decision for a raw provider/plan pair.
type CandidateState string

const (
	CandidateUnconfirmed CandidateState = "unconfirmed"
	CandidateConfirmed   CandidateState = "confirmed"
	CandidateRejected    CandidateState = "rejected"
)

// ServiceIdentifierKind keeps raw usage-cost and usage-limit identifiers
// separate. They are deliberately not inferred from one another.
type ServiceIdentifierKind string

const (
	UsageCostIdentifier  ServiceIdentifierKind = "usage_cost"
	UsageLimitIdentifier ServiceIdentifierKind = "usage_limit"
)

type BillingConfirmation string

const (
	BillingNotApplicable BillingConfirmation = "not_applicable"
	BillingUnconfirmed   BillingConfirmation = "unconfirmed"
	BillingConfirmed     BillingConfirmation = "confirmed"
)

type Service struct {
	ID          string
	Provider    string
	Name        string
	OfficialKey string
	ArchivedAt  *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type ServiceIdentifierMapping struct {
	ID            string
	Kind          ServiceIdentifierKind
	RawIdentifier string
	ServiceID     string
	ValidFrom     time.Time
	ValidTo       *time.Time
	CreatedAt     time.Time
}

type LimitDefinition struct {
	ID                  string
	ServiceID           string
	CycleType           string
	Meaning             string
	Unit                string
	BillingConfirmation BillingConfirmation
	ArchivedAt          *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type Plan struct {
	ID         string
	ServiceID  string
	Name       string
	IsBaseline bool
	ArchivedAt *time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type PlanVersion struct {
	ID                string
	PlanID            string
	Name              string
	ValidFrom         time.Time
	ValidTo           *time.Time
	OfficialSourceURL string
	CreatedAt         time.Time
}

type PlanLimitRule struct {
	ID                string
	PlanVersionID     string
	LimitDefinitionID string
	Limit             *float64
	Multiplier        *float64
	OfficialSourceURL string
	CreatedAt         time.Time
}

type StandardPrice struct {
	ID                string
	PlanVersionID     string
	USDMonthlyPerSeat float64
	SourceURL         string
	ValidFrom         time.Time
	ValidTo           *time.Time
	CreatedAt         time.Time
}

type IdentificationCandidate struct {
	ID                        string
	RawLimitServiceIdentifier string
	RawReportedPlanName       string
	State                     CandidateState
	ServiceID                 *string
	PlanID                    *string
	FirstObservedAt           *time.Time
	LastObservedAt            *time.Time
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

func (s Service) Validate() error {
	if err := requireID(s.ID, "service ID"); err != nil {
		return err
	}
	if err := requireText(s.Provider, "service provider"); err != nil {
		return err
	}
	if err := requireText(s.Name, "service name"); err != nil {
		return err
	}
	if err := requireText(s.OfficialKey, "service official key"); err != nil {
		return err
	}
	if s.CreatedAt.IsZero() || s.UpdatedAt.IsZero() {
		return errors.New("service timestamps are required")
	}
	return nil
}

func (m ServiceIdentifierMapping) Validate() error {
	if err := requireID(m.ID, "service identifier mapping ID"); err != nil {
		return err
	}
	if m.Kind != UsageCostIdentifier && m.Kind != UsageLimitIdentifier {
		return fmt.Errorf("unknown service identifier kind %q", m.Kind)
	}
	if err := requireText(m.RawIdentifier, "raw service identifier"); err != nil {
		return err
	}
	if err := requireID(m.ServiceID, "service ID"); err != nil {
		return err
	}
	if err := validatePeriod(m.ValidFrom, m.ValidTo); err != nil {
		return fmt.Errorf("service identifier mapping: %w", err)
	}
	if m.CreatedAt.IsZero() {
		return errors.New("service identifier mapping creation time is required")
	}
	return nil
}

func (d LimitDefinition) Validate() error {
	if err := requireID(d.ID, "limit definition ID"); err != nil {
		return err
	}
	if err := requireID(d.ServiceID, "service ID"); err != nil {
		return err
	}
	if err := requireText(d.CycleType, "limit cycle type"); err != nil {
		return err
	}
	if err := requireText(d.Meaning, "limit meaning"); err != nil {
		return err
	}
	if err := requireText(d.Unit, "limit unit"); err != nil {
		return err
	}
	if d.BillingConfirmation == "" {
		if d.CycleType == "billing" {
			d.BillingConfirmation = BillingUnconfirmed
		} else {
			d.BillingConfirmation = BillingNotApplicable
		}
	}
	if d.BillingConfirmation != BillingNotApplicable && d.BillingConfirmation != BillingUnconfirmed && d.BillingConfirmation != BillingConfirmed {
		return fmt.Errorf("unknown billing confirmation %q", d.BillingConfirmation)
	}
	if d.CycleType == "billing" && d.BillingConfirmation == BillingNotApplicable {
		return errors.New("billing limit requires a monthly confirmation state")
	}
	if d.CreatedAt.IsZero() || d.UpdatedAt.IsZero() {
		return errors.New("limit definition timestamps are required")
	}
	return nil
}

func (p Plan) Validate() error {
	if err := requireID(p.ID, "plan ID"); err != nil {
		return err
	}
	if err := requireID(p.ServiceID, "service ID"); err != nil {
		return err
	}
	if err := requireText(p.Name, "plan name"); err != nil {
		return err
	}
	if p.CreatedAt.IsZero() || p.UpdatedAt.IsZero() {
		return errors.New("plan timestamps are required")
	}
	return nil
}

func (v PlanVersion) Validate() error {
	if err := requireID(v.ID, "plan version ID"); err != nil {
		return err
	}
	if err := requireID(v.PlanID, "plan ID"); err != nil {
		return err
	}
	if err := requireText(v.Name, "plan version name"); err != nil {
		return err
	}
	if err := validatePeriod(v.ValidFrom, v.ValidTo); err != nil {
		return fmt.Errorf("plan version: %w", err)
	}
	if err := validateSourceURL(v.OfficialSourceURL); err != nil {
		return fmt.Errorf("plan version source URL: %w", err)
	}
	if v.CreatedAt.IsZero() {
		return errors.New("plan version creation time is required")
	}
	return nil
}

func (r PlanLimitRule) Validate() error {
	if err := requireID(r.ID, "plan limit rule ID"); err != nil {
		return err
	}
	if err := requireID(r.PlanVersionID, "plan version ID"); err != nil {
		return err
	}
	if err := requireID(r.LimitDefinitionID, "limit definition ID"); err != nil {
		return err
	}
	if r.Limit != nil && (!finite(*r.Limit) || *r.Limit < 0) {
		return errors.New("plan limit must be finite and non-negative")
	}
	if r.Multiplier != nil && (!finite(*r.Multiplier) || *r.Multiplier <= 0) {
		return errors.New("limit multiplier must be finite and positive")
	}
	if err := validateSourceURL(r.OfficialSourceURL); err != nil {
		return fmt.Errorf("plan limit rule source URL: %w", err)
	}
	if r.CreatedAt.IsZero() {
		return errors.New("plan limit rule creation time is required")
	}
	return nil
}

func (p StandardPrice) Validate() error {
	if err := requireID(p.ID, "standard price ID"); err != nil {
		return err
	}
	if err := requireID(p.PlanVersionID, "plan version ID"); err != nil {
		return err
	}
	if !finite(p.USDMonthlyPerSeat) || p.USDMonthlyPerSeat <= 0 {
		return errors.New("standard price must be finite and positive")
	}
	if err := validateSourceURL(p.SourceURL); err != nil {
		return fmt.Errorf("standard price source URL: %w", err)
	}
	if err := validatePeriod(p.ValidFrom, p.ValidTo); err != nil {
		return fmt.Errorf("standard price: %w", err)
	}
	if p.CreatedAt.IsZero() {
		return errors.New("standard price creation time is required")
	}
	return nil
}

func (c IdentificationCandidate) Validate() error {
	if err := requireID(c.ID, "identification candidate ID"); err != nil {
		return err
	}
	if err := requireText(c.RawLimitServiceIdentifier, "raw limit service identifier"); err != nil {
		return err
	}
	if err := requireText(c.RawReportedPlanName, "raw reported plan name"); err != nil {
		return err
	}
	if c.State == "" {
		c.State = CandidateUnconfirmed
	}
	if c.State != CandidateUnconfirmed && c.State != CandidateConfirmed && c.State != CandidateRejected {
		return fmt.Errorf("unknown identification candidate state %q", c.State)
	}
	if c.State == CandidateConfirmed && (c.ServiceID == nil || c.PlanID == nil || *c.ServiceID == "" || *c.PlanID == "") {
		return errors.New("confirmed candidate requires service and plan")
	}
	if c.State != CandidateConfirmed && (c.ServiceID != nil || c.PlanID != nil) {
		return errors.New("unconfirmed or rejected candidate cannot reference service or plan")
	}
	if c.FirstObservedAt != nil && c.LastObservedAt != nil && c.LastObservedAt.Before(*c.FirstObservedAt) {
		return errors.New("candidate observation interval is reversed")
	}
	if c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() {
		return errors.New("identification candidate timestamps are required")
	}
	return nil
}

func ValidatePeriod(start time.Time, end *time.Time) error { return validatePeriod(start, end) }

func PeriodsOverlap(aStart time.Time, aEnd *time.Time, bStart time.Time, bEnd *time.Time) bool {
	if aEnd != nil && !bStart.Before(*aEnd) {
		return false
	}
	if bEnd != nil && !aStart.Before(*bEnd) {
		return false
	}
	return true
}

func validatePeriod(start time.Time, end *time.Time) error {
	if start.IsZero() {
		return errors.New("period start is required")
	}
	if end != nil && !start.Before(*end) {
		return errors.New("period end must be after period start")
	}
	return nil
}

func requireID(value, label string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", label)
	}
	return nil
}

func requireText(value, label string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("%s is required", label)
	}
	return nil
}

func validateSourceURL(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("source URL is required")
	}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return errors.New("source URL must be an absolute URL")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return errors.New("source URL must use HTTP or HTTPS")
	}
	return nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
