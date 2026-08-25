package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"token-monitor-analytics/internal/adapter/hubapi"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
)

// CollectionReader is the read-only part of the SQLite lifecycle required by
// the M07/M08 view. Keeping it as a port makes the Wails adapter testable
// without making the DTO layer know about SQL.
type CollectionReader interface {
	ListCollectionAttempts(context.Context, string) ([]sqliteadapter.CollectionAttempt, error)
	ListRawSnapshots(context.Context, string) ([]sqliteadapter.RawSnapshot, error)
	GetRawSnapshot(context.Context, string) (sqliteadapter.RawSnapshot, error)
	ListCostObservations(context.Context, string) ([]sqliteadapter.CostObservation, error)
	ListLimitObservations(context.Context, string) ([]sqliteadapter.LimitObservation, error)
}

// CollectionScheduler is intentionally small so Start, Stop, and CollectNow
// can be delegated to the timer owner. The scheduler also owns the usecase,
// including the disabled and duplicate-in-flight rules.
type CollectionScheduler interface {
	Start(context.Context, string) error
	Stop(context.Context, string) error
	CollectNow(context.Context, string) error
}

type CollectionService struct {
	reader    CollectionReader
	scheduler CollectionScheduler
}

// NewCollectionService constructs the Wails collection adapter. The returned
// error is stable and does not expose dependency details.
func NewCollectionService(lifecycle *sqliteadapter.Lifecycle, scheduler CollectionScheduler) (*CollectionService, error) {
	if lifecycle == nil {
		return nil, errors.New("collection service dependencies are required")
	}
	return NewCollectionServiceWithDependencies(lifecycle, scheduler)
}

func NewCollectionServiceWithDependencies(reader CollectionReader, scheduler CollectionScheduler) (*CollectionService, error) {
	if reader == nil || scheduler == nil {
		return nil, errors.New("collection service dependencies are required")
	}
	return &CollectionService{reader: reader, scheduler: scheduler}, nil
}

// StartCollection enables collection and starts the scheduler job for one
// Hub. Disabled-Hub validation remains in the collection usecase/scheduler.
func (s *CollectionService) StartCollection(ctx context.Context, hubID string) error {
	if s == nil || s.scheduler == nil {
		return errors.New("collection service is unavailable")
	}
	if err := s.scheduler.Start(ctx, hubID); err != nil {
		return collectionOperationError(err)
	}
	return nil
}

// StopCollection disables collection and cancels the scheduler job for one
// Hub.
func (s *CollectionService) StopCollection(ctx context.Context, hubID string) error {
	if s == nil || s.scheduler == nil {
		return errors.New("collection service is unavailable")
	}
	if err := s.scheduler.Stop(ctx, hubID); err != nil {
		return collectionOperationError(err)
	}
	return nil
}

// CollectNow delegates a manual collection to the scheduler/usecase. The
// result, including a disabled or duplicate-in-flight skip, is persisted in
// the attempt history by that layer.
func (s *CollectionService) CollectNow(ctx context.Context, hubID string) error {
	if s == nil || s.scheduler == nil {
		return errors.New("collection service is unavailable")
	}
	if err := s.scheduler.CollectNow(ctx, hubID); err != nil {
		return collectionOperationError(err)
	}
	return nil
}

// GetCollectionAttempts returns the M07 acquisition history without exposing
// credentials or arbitrary error detail.
func (s *CollectionService) GetCollectionAttempts(ctx context.Context, hubID string) ([]CollectionAttemptSnapshot, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("collection service is unavailable")
	}
	rows, err := s.reader.ListCollectionAttempts(ctx, hubID)
	if err != nil {
		return nil, collectionReadError(err)
	}
	result := make([]CollectionAttemptSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, collectionAttemptSnapshot(row))
	}
	return result, nil
}

// GetRawSnapshots returns M08 snapshot metadata only. Body is deliberately
// absent from this DTO; callers must request one explicit detail.
func (s *CollectionService) GetRawSnapshots(ctx context.Context, hubID string) ([]RawSnapshotSnapshot, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("collection service is unavailable")
	}
	rows, err := s.reader.ListRawSnapshots(ctx, hubID)
	if err != nil {
		return nil, collectionReadError(err)
	}
	result := make([]RawSnapshotSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, rawSnapshotSnapshot(row))
	}
	return result, nil
}

// GetRawSnapshot returns a masked viewer representation. The persisted bytes
// are never returned through a Wails DTO; usecase/SQLite retain them for
// evidence and exactness tests.
func (s *CollectionService) GetRawSnapshot(ctx context.Context, snapshotID string) (RawSnapshotDetail, error) {
	if s == nil || s.reader == nil {
		return RawSnapshotDetail{}, errors.New("collection service is unavailable")
	}
	row, err := s.reader.GetRawSnapshot(ctx, snapshotID)
	if err != nil {
		return RawSnapshotDetail{}, collectionReadError(err)
	}
	body, err := maskedRawBody(row.Body, row.ResponseKind)
	if err != nil {
		return RawSnapshotDetail{}, err
	}
	item := rawSnapshotSnapshot(row)
	return RawSnapshotDetail{
		RawSnapshotSnapshot: item,
		Body:                body,
	}, nil
}

// GetCostObservations returns normalized usage-cost source observations.
func (s *CollectionService) GetCostObservations(ctx context.Context, hubID string) ([]CostObservationSnapshot, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("collection service is unavailable")
	}
	rows, err := s.reader.ListCostObservations(ctx, hubID)
	if err != nil {
		return nil, collectionReadError(err)
	}
	result := make([]CostObservationSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, costObservationSnapshot(row))
	}
	return result, nil
}

// GetLimitObservations returns normalized usage-limit source observations.
func (s *CollectionService) GetLimitObservations(ctx context.Context, hubID string) ([]LimitObservationSnapshot, error) {
	if s == nil || s.reader == nil {
		return nil, errors.New("collection service is unavailable")
	}
	rows, err := s.reader.ListLimitObservations(ctx, hubID)
	if err != nil {
		return nil, collectionReadError(err)
	}
	result := make([]LimitObservationSnapshot, 0, len(rows))
	for _, row := range rows {
		result = append(result, limitObservationSnapshot(row))
	}
	return result, nil
}

type CollectionAttemptSnapshot struct {
	AttemptID                string `json:"attemptId"`
	HubID                    string `json:"hubId"`
	Trigger                  string `json:"trigger"`
	State                    string `json:"state"`
	StartedAt                string `json:"startedAt"`
	CompletedAt              string `json:"completedAt"`
	AnalyticsIntervalSeconds int64  `json:"analyticsIntervalSeconds"`
	HealthHTTPStatus         *int   `json:"healthHttpStatus,omitempty"`
	StatsHTTPStatus          *int   `json:"statsHttpStatus,omitempty"`
	APIContract              string `json:"apiContract"`
	HealthSnapshotID         string `json:"healthSnapshotId"`
	StatsSnapshotID          string `json:"statsSnapshotId"`
	FailureCode              string `json:"failureCode"`
	FailureDetail            string `json:"failureDetail"`
	NormalizationErrorPath   string `json:"normalizationErrorPath"`
}

type RawSnapshotSnapshot struct {
	SnapshotID          string `json:"snapshotId"`
	AttemptID           string `json:"attemptId"`
	HubID               string `json:"hubId"`
	ResponseKind        string `json:"responseKind"`
	ReceivedStartedAt   string `json:"receivedStartedAt"`
	ReceivedCompletedAt string `json:"receivedCompletedAt"`
	HTTPStatus          int    `json:"httpStatus"`
	APIContract         string `json:"apiContract"`
}

type RawSnapshotDetail struct {
	RawSnapshotSnapshot
	// Body is the redacted display text, never the persisted raw bytes.
	Body string `json:"body"`
}

type CostObservationSnapshot struct {
	ObservationID             string `json:"observationId"`
	SnapshotID                string `json:"snapshotId"`
	HubID                     string `json:"hubId"`
	DeviceID                  string `json:"deviceId"`
	RawServiceIdentifier      string `json:"rawServiceIdentifier"`
	UsageUpdatedAt            string `json:"usageUpdatedAt"`
	CostUSDText               string `json:"costUsdText"`
	SyncUploadIntervalMS      *int64 `json:"syncUploadIntervalMs,omitempty"`
	AnalyticsIntervalSeconds  int64  `json:"analyticsIntervalSeconds"`
	SourceTimezone            string `json:"sourceTimezone"`
	SourceLocalDate           string `json:"sourceLocalDate"`
	NormalizationGeneration   int64  `json:"normalizationGeneration"`
	NormalizationRuleVersion  string `json:"normalizationRuleVersion"`
	NormalizationLogicVersion string `json:"normalizationLogicVersion"`
	JSONPath                  string `json:"jsonPath"`
	DedupeState               string `json:"dedupeState"`
	DedupeKey                 string `json:"dedupeKey"`
	ValueFingerprint          string `json:"valueFingerprint"`
}

type LimitObservationSnapshot struct {
	ObservationID             string   `json:"observationId"`
	SnapshotID                string   `json:"snapshotId"`
	HubID                     string   `json:"hubId"`
	DeviceID                  string   `json:"deviceId"`
	RawServiceIdentifier      string   `json:"rawServiceIdentifier"`
	AccountKey                string   `json:"accountKey"`
	ProviderUpdatedAt         string   `json:"providerUpdatedAt"`
	WindowKey                 string   `json:"windowKey"`
	NormalizedKind            string   `json:"normalizedKind"`
	NormalizedMetric          string   `json:"normalizedMetric"`
	NormalizedLabel           string   `json:"normalizedLabel"`
	PlanLabel                 string   `json:"planLabel"`
	UsedPercent               *float64 `json:"usedPercent,omitempty"`
	RemainingPercent          *float64 `json:"remainingPercent,omitempty"`
	ResetsAt                  string   `json:"resetsAt"`
	SyncUploadIntervalMS      *int64   `json:"syncUploadIntervalMs,omitempty"`
	LimitsRefreshMS           *int64   `json:"limitsRefreshMs,omitempty"`
	AnalyticsIntervalSeconds  int64    `json:"analyticsIntervalSeconds"`
	SourceTimezone            string   `json:"sourceTimezone"`
	SourceLocalDate           string   `json:"sourceLocalDate"`
	NormalizationGeneration   int64    `json:"normalizationGeneration"`
	NormalizationRuleVersion  string   `json:"normalizationRuleVersion"`
	NormalizationLogicVersion string   `json:"normalizationLogicVersion"`
	JSONPath                  string   `json:"jsonPath"`
	DedupeState               string   `json:"dedupeState"`
	DedupeKey                 string   `json:"dedupeKey"`
	ValueFingerprint          string   `json:"valueFingerprint"`
	WindowKeyConflict         bool     `json:"windowKeyConflict"`
}

// Common aliases keep the DTO naming consistent with the other desktop
// services and with callers that refer to rows as DTOs.
type CollectionAttemptDTO = CollectionAttemptSnapshot
type RawSnapshotDTO = RawSnapshotSnapshot
type CostObservationDTO = CostObservationSnapshot
type LimitObservationDTO = LimitObservationSnapshot

func collectionAttemptSnapshot(value sqliteadapter.CollectionAttempt) CollectionAttemptSnapshot {
	return CollectionAttemptSnapshot{
		AttemptID: value.AttemptID, HubID: value.HubID, Trigger: value.Trigger, State: value.State,
		StartedAt: formatOptional(value.StartedAt), CompletedAt: formatTimePtr(value.CompletedAt),
		AnalyticsIntervalSeconds: value.AnalyticsIntervalSeconds, HealthHTTPStatus: cloneInt(value.HealthHTTPStatus),
		StatsHTTPStatus: cloneInt(value.StatsHTTPStatus), APIContract: safeContract(value.APIContract),
		HealthSnapshotID: value.HealthSnapshotID, StatsSnapshotID: value.StatsSnapshotID,
		FailureCode: safeFailureCode(value.FailureCode), FailureDetail: safeFailureDetail(value.FailureDetail),
		NormalizationErrorPath: safeJSONPath(value.NormalizationErrorPath),
	}
}

func rawSnapshotSnapshot(value sqliteadapter.RawSnapshot) RawSnapshotSnapshot {
	return RawSnapshotSnapshot{
		SnapshotID: value.SnapshotID, AttemptID: value.AttemptID, HubID: value.HubID,
		ResponseKind: value.ResponseKind, ReceivedStartedAt: formatOptional(value.ReceivedStartedAt),
		ReceivedCompletedAt: formatOptional(value.ReceivedCompletedAt), HTTPStatus: value.HTTPStatus,
		APIContract: safeContract(value.APIContract),
	}
}

func costObservationSnapshot(value sqliteadapter.CostObservation) CostObservationSnapshot {
	return CostObservationSnapshot{
		ObservationID: value.ObservationID, SnapshotID: value.SnapshotID, HubID: value.HubID,
		DeviceID: value.DeviceID, RawServiceIdentifier: value.RawServiceIdentifier,
		UsageUpdatedAt: formatOptional(value.UsageUpdatedAt), CostUSDText: value.CostUSDText,
		SyncUploadIntervalMS: cloneInt64(value.SyncUploadIntervalMS), AnalyticsIntervalSeconds: value.AnalyticsIntervalSeconds,
		SourceTimezone: value.SourceTimezone, SourceLocalDate: value.SourceLocalDate,
		NormalizationGeneration: value.NormalizationGeneration, NormalizationRuleVersion: value.NormalizationRuleVersion,
		NormalizationLogicVersion: value.NormalizationLogicVersion, JSONPath: safeJSONPath(value.JSONPath),
		DedupeState: value.DedupeState, DedupeKey: value.DedupeKey, ValueFingerprint: value.ValueFingerprint,
	}
}

func limitObservationSnapshot(value sqliteadapter.LimitObservation) LimitObservationSnapshot {
	var remaining *float64
	if value.UsedPercent != nil {
		computed := 100 - *value.UsedPercent
		remaining = &computed
	}
	return LimitObservationSnapshot{
		ObservationID: value.ObservationID, SnapshotID: value.SnapshotID, HubID: value.HubID,
		DeviceID: value.DeviceID, RawServiceIdentifier: value.RawServiceIdentifier, AccountKey: value.AccountKey,
		ProviderUpdatedAt: formatOptional(value.ProviderUpdatedAt), WindowKey: value.WindowKey,
		NormalizedKind: value.NormalizedKind, NormalizedMetric: value.NormalizedMetric, NormalizedLabel: value.NormalizedLabel,
		PlanLabel: value.PlanLabel, UsedPercent: cloneFloat64(value.UsedPercent), RemainingPercent: remaining,
		ResetsAt: formatTimePtr(value.ResetsAt), SyncUploadIntervalMS: cloneInt64(value.SyncUploadIntervalMS),
		LimitsRefreshMS: cloneInt64(value.LimitsRefreshMS), AnalyticsIntervalSeconds: value.AnalyticsIntervalSeconds,
		SourceTimezone: value.SourceTimezone, SourceLocalDate: value.SourceLocalDate,
		NormalizationGeneration: value.NormalizationGeneration, NormalizationRuleVersion: value.NormalizationRuleVersion,
		NormalizationLogicVersion: value.NormalizationLogicVersion, JSONPath: safeJSONPath(value.JSONPath),
		DedupeState: value.DedupeState, DedupeKey: value.DedupeKey, ValueFingerprint: value.ValueFingerprint,
		WindowKeyConflict: value.WindowKeyConflict,
	}
}

func cloneInt(value *int) *int {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func cloneFloat64(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func formatTimePtr(value *time.Time) string {
	if value == nil {
		return ""
	}
	return formatOptional(*value)
}

func collectionReadError(errorValue error) error {
	if errorValue == nil {
		return nil
	}
	return errors.New("collection data could not be read")
}

func collectionOperationError(errorValue error) error {
	if errorValue == nil {
		return nil
	}
	classification := hubapi.ClassificationOf(errorValue)
	if classification != "" {
		return fmt.Errorf("collection operation failed: %s", classification)
	}
	if errors.Is(errorValue, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(errorValue, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	return errors.New("collection operation failed")
}

var safeCollectionFailureCodes = map[string]struct{}{
	"": {}, "hub_disabled": {}, "collection_disabled": {}, "duplicate_in_flight": {}, "storage": {}, "normalization_failed": {},
	"auth": {}, "tls": {}, "timeout": {}, "unreachable": {}, "unsupported": {}, "invalid_json": {},
	"body_too_large": {}, "http": {}, "collection": {},
}

func safeFailureCode(value string) string {
	if _, ok := safeCollectionFailureCodes[value]; ok {
		return value
	}
	if value == "" {
		return ""
	}
	return "collection"
}

func safeFailureDetail(value string) string {
	switch value {
	case "", "collection failed", "raw snapshot could not be saved", "stats normalization failed", "normalized observations could not be saved", "credential is not ready":
		return value
	case "auth", "tls", "timeout", "unreachable", "unsupported", "invalid_json", "body_too_large", "http":
		return value
	default:
		return "collection failed"
	}
}

func safeContract(value string) string {
	if value == "" || len(value) > 256 || strings.ContainsAny(value, "\r\n") {
		return ""
	}
	return value
}

func safeJSONPath(value string) string {
	if value == "" || len(value) > 2048 || strings.ContainsAny(value, "\r\n") {
		return ""
	}
	return value
}

const maskedValue = "[MASKED]"

// maskedRawBody parses the persisted JSON and emits a compact display-only
// representation. Values at contract-known paths are retained; unknown and
// credential-like fields are always replaced. Invalid persisted JSON is an
// explicit read error and none of its bytes are returned.
func maskedRawBody(raw []byte, responseKind string) (string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return "", errors.New("persisted raw snapshot is not valid JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return "", errors.New("persisted raw snapshot has trailing JSON data")
	}
	redacted := redactRawValue(value, rawPath{kind: responseKind})
	encoded, err := json.Marshal(redacted)
	if err != nil {
		return "", errors.New("masked raw snapshot could not be encoded")
	}
	return string(encoded), nil
}

type rawPath struct {
	kind  string
	parts []string
}

func redactRawValue(value any, path rawPath) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, child := range typed {
			childPath := rawPath{kind: path.kind, parts: append(append([]string(nil), path.parts...), key)}
			if domain.IsRawSecretField(key) || !domain.IsKnownRawField(childPath.kind, childPath.parts) {
				result[key] = maskedValue
				continue
			}
			result[key] = redactRawValue(child, childPath)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, child := range typed {
			result[index] = redactRawValue(child, rawPath{kind: path.kind, parts: append(path.parts, fmt.Sprintf("[%d]", index))})
		}
		return result
	default:
		return value
	}
}
