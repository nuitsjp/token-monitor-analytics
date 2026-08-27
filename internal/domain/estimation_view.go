package domain

import "time"

// LimitSeriesView is the read model for M03. It deliberately contains only
// values needed by the screen; the persisted result remains the source of
// truth for estimation details and evidence.
type LimitSeriesView struct {
	ID                  string
	ServiceID           string
	ServiceName         string
	LogicalAccountID    string
	LogicalAccountName  string
	LimitDefinitionID   string
	LimitDefinitionName string
	CycleType           string
	BillingConfirmation BillingConfirmation
	UsageLimitSourceID  string
	AssociationID       string
	NormalizedKind      string
	NormalizedMetric    string
	PlanHistoryID       string
	PlanVersionID       string
	PlanVersionName     string
	PlanLimitRuleID     string
	PlanLimit           *float64
	Multiplier          *float64
	UsedPercent         *float64
	RemainingPercent    *float64
	ResetAt             *time.Time
	LatestObservationAt *time.Time
	HasConflict         bool
	SeriesState         string
	Interval            *CalculationIntervalView
}

type CalculationIntervalView struct {
	ID                 string
	ServiceID          string
	LogicalAccountID   string
	UsageLimitSourceID string
	LimitDefinitionID  string
	PlanVersionID      string
	CycleType          string
	ValidFrom          time.Time
	ValidTo            time.Time
	State              string
	ExclusionReason    string
	BoundaryIDs        []string
	Boundaries         []CalculationBoundaryView
}

type CalculationBoundaryView struct {
	ID        string
	Kind      string
	At        time.Time
	Reason    string
	RelatedID string
}

type LimitSeriesDetail struct {
	Series  LimitSeriesView
	Result  *DerivedResult
	History []CalculationIntervalView
	Current *CalculationIntervalView
}
