package domain

import "time"

// The following read/write models are ports shared by the application and its
// output adapters. They intentionally contain no database or transport types.

type Hub struct {
	ID                        string
	DisplayName               string
	URL                       string
	Enabled                   bool
	CollectionEnabled         bool
	CollectionIntervalSeconds int64
	APIContract               *string
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type HubRow struct {
	Hub                   Hub
	ConnectionState       string
	ConnectionCheckedAt   *time.Time
	ConnectionFailureNote string
}

type CredentialAuditEvent struct {
	Sequence int64
	Action   string
}

type CredentialAudit struct {
	AuditID    string
	OccurredAt time.Time
	Action     string
	HubID      string
	BeforeJSON string
	AfterJSON  string
}

type HubConnectionAttempt struct {
	AttemptID     string
	HubID         string
	CheckedAt     time.Time
	State         string
	APIContract   string
	FailureDetail string
}

type CollectionAttempt struct {
	AttemptID                string
	HubID                    string
	Trigger                  string
	State                    string
	StartedAt                time.Time
	CompletedAt              *time.Time
	AnalyticsIntervalSeconds int64
	HealthHTTPStatus         *int
	StatsHTTPStatus          *int
	APIContract              string
	HealthSnapshotID         string
	StatsSnapshotID          string
	FailureCode              string
	FailureDetail            string
	NormalizationErrorPath   string
}

type RawSnapshot struct {
	SnapshotID          string
	AttemptID           string
	HubID               string
	ResponseKind        string
	ReceivedStartedAt   time.Time
	ReceivedCompletedAt time.Time
	HTTPStatus          int
	APIContract         string
	Body                []byte
}

type CostObservation struct {
	ObservationID             string
	UsageCostSourceID         string
	SnapshotID                string
	HubID                     string
	DeviceID                  string
	RawServiceIdentifier      string
	UsageUpdatedAt            time.Time
	CostUSDText               string
	SyncUploadIntervalMS      *int64
	AnalyticsIntervalSeconds  int64
	SourceTimezone            string
	SourceLocalDate           string
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	JSONPath                  string
	DedupeState               string
	DedupeKey                 string
	ValueFingerprint          string
	OccurrenceCount           int64
	FirstSeenAt               time.Time
	LastSeenAt                time.Time
	LastSeenSnapshotID        string
}

type CollectionUsageObservation struct {
	ObservationID             string
	UsageCostSourceID         string
	SnapshotID                string
	HubID                     string
	DeviceID                  string
	RawServiceIdentifier      string
	UsageUpdatedAt            time.Time
	TokenCount                int64
	APICostUSDText            string
	ModelTokens               map[string]int64
	ModelCosts                map[string]string
	SourceTimezone            string
	SourceLocalDate           string
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	JSONPath                  string
	DedupeState               string
	DedupeKey                 string
	ValueFingerprint          string
	OccurrenceCount           int64
	FirstSeenAt               time.Time
	LastSeenAt                time.Time
	LastSeenSnapshotID        string
}

type IdentificationCandidateObservation struct {
	ID                string
	CandidateID       string
	HubID             string
	HubAccountDisplay string
	ObservedAt        time.Time
}

type LimitObservation struct {
	ObservationID             string
	UsageLimitSourceID        string
	HubAccountCandidateID     string
	IdentificationCandidateID string
	SnapshotID                string
	HubID                     string
	DeviceID                  string
	RawServiceIdentifier      string
	AccountKey                string
	ProviderUpdatedAt         time.Time
	WindowKey                 string
	NormalizedKind            string
	NormalizedMetric          string
	NormalizedLabel           string
	PlanLabel                 string
	UsedPercent               *float64
	AbsoluteUsedText          string
	AbsoluteLimitText         string
	AbsoluteRemainingText     string
	Currency                  string
	ResetsAt                  *time.Time
	SyncUploadIntervalMS      *int64
	LimitsRefreshMS           *int64
	AnalyticsIntervalSeconds  int64
	SourceTimezone            string
	SourceLocalDate           string
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	JSONPath                  string
	DedupeState               string
	DedupeKey                 string
	ValueFingerprint          string
	WindowKeyConflict         bool
	OccurrenceCount           int64
	FirstSeenAt               time.Time
	LastSeenAt                time.Time
	LastSeenSnapshotID        string
}

type OverviewData struct {
	TimezoneConfirmed          bool
	Hubs                       []OverviewHub
	ReviewActionCount          int
	ReviewWarningCount         int
	ReviewActionKindCounts     map[string]int
	ReviewWarningKindCounts    map[string]int
	RecalculationFailureCount  int
	EstimationStatusCounts     map[string]int
	RawSnapshotCount           int64
	OldestSnapshotAt           *time.Time
	LatestSnapshotAt           *time.Time
	ServiceCount               int
	LogicalAccountCount        int
	LimitAssociationCount      int
	CostAssociationCount       int
	ConfirmedCompletenessCount int
	DatabaseSizeBytes          int64
	RecentLimits               []OverviewRecentLimit
}

type OverviewHub struct {
	ID                        string
	DisplayName               string
	Enabled                   bool
	CollectionEnabled         bool
	CollectionIntervalSeconds int64
	ConnectionState           string
	CollectionRunning         bool
	LastCollectionState       string
	LastCollectionAt          *time.Time
	LastSuccessAt             *time.Time
	LastFailureAt             *time.Time
	LastSkippedAt             *time.Time
}

type OverviewRecentLimit struct {
	LogicalAccountID    string
	LimitDefinitionID   string
	ServiceName         string
	AccountName         string
	LimitName           string
	CycleType           string
	UsedPercent         float64
	EstimatedLimit      *float64
	ResetsAt            *time.Time
	LastIncreaseAt      time.Time
	LatestObservationAt time.Time
	ExpectedInterval    time.Duration
	// ObservationOnly is true when this item is shown from the latest
	// canonical observation because no estimable interval is available. In
	// that case LastIncreaseAt is only a display-compatible timestamp and must
	// not be described as an increase.
	ObservationOnly bool
}

type AuditListOptions struct {
	Cursor     string
	Limit      int
	From       *time.Time
	To         *time.Time
	EntityType string
	Action     string
}

type ConfigurationAudit struct {
	Sequence   int64
	AuditID    string
	OccurredAt time.Time
	Actor      string
	Action     string
	EntityType string
	EntityID   string
	BeforeJSON string
	AfterJSON  string
}

type ConfigurationAuditPage struct {
	Items      []ConfigurationAudit
	NextCursor string
	HasMore    bool
}

type WindowPlacement struct {
	X       int
	Y       int
	Width   int
	Height  int
	DPI     int
	Monitor string
}

type UsageNativeAmount struct {
	ObservationID, SnapshotID, HubID, HubName, DeviceID string
	RawServiceIdentifier, WindowKey, Label, Metric      string
	ObservedAt                                          time.Time
	UsedText, LimitText, RemainingText, Currency        string
	JSONPath                                            string
}

type DisplaySettings struct {
	Theme             string
	DisplayTimezone   string
	TimezoneConfirmed bool
}
