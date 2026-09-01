package domain

type RawNormalizationInput struct {
	SnapshotID               string
	HubID                    string
	Body                     []byte
	AnalyticsIntervalSeconds int64
}

// ReconciliationSummary reports only material configuration changes. A
// repeated reconciliation that finds no gaps returns the zero value.
type ReconciliationSummary struct {
	ServicesCreated          int
	MappingsCreated          int
	PlansCreated             int
	PlanVersionsCreated      int
	EntitlementsObserved     int
	AccountsCreated          int
	PlanHistoriesCreated     int
	LimitDefinitionsCreated  int
	LimitAssociationsCreated int
	CostAssociationsCreated  int
	CompletenessConfirmed    int
}

func (s ReconciliationSummary) Changed() bool {
	return s.ServicesCreated+s.MappingsCreated+s.PlansCreated+s.PlanVersionsCreated+
		s.EntitlementsObserved+s.AccountsCreated+s.PlanHistoriesCreated+
		s.LimitDefinitionsCreated+s.LimitAssociationsCreated+
		s.CostAssociationsCreated+s.CompletenessConfirmed > 0
}
