package desktop

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

const privacyMask = "••••"

type OverviewReader interface {
	ReadOverviewData(context.Context, time.Time) (sqliteadapter.OverviewData, error)
	ListCredentialAuditEvents(context.Context, string) ([]sqliteadapter.CredentialAuditEvent, error)
}

type OverviewService struct {
	reader   OverviewReader
	clock    usecase.Clock
	recovery domain.RestoreRecoveryResult
}

type OverviewSnapshot struct {
	GeneratedAt       string                            `json:"generatedAt"`
	TimezoneConfirmed bool                              `json:"timezoneConfirmed"`
	RecoveryNotice    *OverviewRecoveryNoticeSnapshot   `json:"recoveryNotice"`
	Checklist         []OverviewChecklistItemSnapshot   `json:"checklist"`
	Hubs              OverviewHubSummarySnapshot        `json:"hubs"`
	Review            OverviewReviewSummarySnapshot     `json:"review"`
	Estimation        OverviewEstimationSummarySnapshot `json:"estimation"`
	Capacity          OverviewCapacitySnapshot          `json:"capacity"`
	RecentLimits      []OverviewRecentLimitSnapshot     `json:"recentLimits"`
}

type OverviewRecoveryNoticeSnapshot struct {
	Status         StatusPresentationSnapshot `json:"status"`
	ArtifactSHA256 string                     `json:"artifactSha256"`
}

type OverviewChecklistItemSnapshot struct {
	Step       int                        `json:"step"`
	Title      string                     `json:"title"`
	Status     StatusPresentationSnapshot `json:"status"`
	Route      string                     `json:"route"`
	Actionable bool                       `json:"actionable"`
}

type OverviewStatusCountSnapshot struct {
	Status StatusPresentationSnapshot `json:"status"`
	Count  int                        `json:"count"`
}

type OverviewHubSummarySnapshot struct {
	TotalCount              int                           `json:"totalCount"`
	EnabledCount            int                           `json:"enabledCount"`
	ScheduledCount          int                           `json:"scheduledCount"`
	RunningCount            int                           `json:"runningCount"`
	AbnormalCount           int                           `json:"abnormalCount"`
	CredentialReadyCount    int                           `json:"credentialReadyCount"`
	LastSuccessAt           string                        `json:"lastSuccessAt"`
	ConnectionStates        []OverviewStatusCountSnapshot `json:"connectionStates"`
	CurrentCollectionStates []OverviewStatusCountSnapshot `json:"currentCollectionStates"`
	LastCollectionStates    []OverviewStatusCountSnapshot `json:"lastCollectionStates"`
	Items                   []OverviewHubSnapshot         `json:"items"`
}

type OverviewHubSnapshot struct {
	ID                string                     `json:"id"`
	DisplayName       string                     `json:"displayName"`
	Enabled           bool                       `json:"enabled"`
	CollectionEnabled bool                       `json:"collectionEnabled"`
	Connection        StatusPresentationSnapshot `json:"connection"`
	CurrentCollection StatusPresentationSnapshot `json:"currentCollection"`
	LastCollection    StatusPresentationSnapshot `json:"lastCollection"`
	LastCollectionAt  string                     `json:"lastCollectionAt"`
	LastSuccessAt     string                     `json:"lastSuccessAt"`
	LastFailureAt     string                     `json:"lastFailureAt"`
	LastSkippedAt     string                     `json:"lastSkippedAt"`
}

type OverviewReviewSummarySnapshot struct {
	ActionItems           OverviewStatusCountSnapshot `json:"actionItems"`
	Warnings              OverviewStatusCountSnapshot `json:"warnings"`
	RecalculationFailures OverviewStatusCountSnapshot `json:"recalculationFailures"`
	ActionKinds           []OverviewKindCountSnapshot `json:"actionKinds"`
	WarningKinds          []OverviewKindCountSnapshot `json:"warningKinds"`
}

type OverviewKindCountSnapshot struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type OverviewEstimationSummarySnapshot struct {
	States []OverviewStatusCountSnapshot `json:"states"`
}

type OverviewCapacitySnapshot struct {
	DatabaseSizeBytes int64  `json:"databaseSizeBytes"`
	RawSnapshotCount  int64  `json:"rawSnapshotCount"`
	OldestSnapshotAt  string `json:"oldestSnapshotAt"`
	LatestSnapshotAt  string `json:"latestSnapshotAt"`
}

type OverviewFreshnessSnapshot struct {
	Status        StatusPresentationSnapshot `json:"status"`
	Reason        string                     `json:"reason"`
	ObservationAt string                     `json:"observationAt"`
	AgeLabel      string                     `json:"ageLabel"`
}

type OverviewTimeSnapshot struct {
	OccurredAt string `json:"occurredAt"`
	AgeLabel   string `json:"ageLabel"`
}

type OverviewRecentLimitSnapshot struct {
	LogicalAccountID     string                     `json:"logicalAccountId"`
	LimitDefinitionID    string                     `json:"limitDefinitionId"`
	ServiceName          string                     `json:"serviceName"`
	AccountName          string                     `json:"accountName"`
	LimitName            string                     `json:"limitName"`
	CycleType            string                     `json:"cycleType"`
	RemainingPercent     *float64                   `json:"remainingPercent"`
	RemainingLabel       string                     `json:"remainingLabel"`
	RemainingDetailLabel string                     `json:"remainingDetailLabel"`
	Remaining            StatusPresentationSnapshot `json:"remaining"`
	ResetAt              string                     `json:"resetAt"`
	Reset                StatusPresentationSnapshot `json:"reset"`
	LastIncrease         OverviewTimeSnapshot       `json:"lastIncrease"`
	Freshness            OverviewFreshnessSnapshot  `json:"freshness"`
	PrivacyMasked        bool                       `json:"privacyMasked"`
	AccessibleLabel      string                     `json:"accessibleLabel"`
	Tooltip              string                     `json:"tooltip"`
}

func NewOverviewService(lifecycle *sqliteadapter.Lifecycle, recovery domain.RestoreRecoveryResult) (*OverviewService, error) {
	return NewOverviewServiceWithDependencies(lifecycle, usecase.SystemClock{}, recovery)
}

func NewOverviewServiceWithDependencies(reader OverviewReader, clock usecase.Clock, recovery domain.RestoreRecoveryResult) (*OverviewService, error) {
	if reader == nil {
		return nil, errors.New("overview reader is required")
	}
	if clock == nil {
		return nil, errors.New("overview clock is required")
	}
	return &OverviewService{reader: reader, clock: clock, recovery: recovery}, nil
}

// GetOverview returns display-ready domain decisions. In privacy mode the raw
// sensitive values never cross the Go/Wails boundary.
func (s *OverviewService) GetOverview(ctx context.Context, privacyMode bool) (OverviewSnapshot, error) {
	if s == nil || s.reader == nil || s.clock == nil {
		return OverviewSnapshot{}, errors.New("overview service is unavailable")
	}
	now := s.clock.Now().UTC()
	data, err := s.reader.ReadOverviewData(ctx, now)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	hubs, err := s.mapHubSummary(ctx, data.Hubs)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	review, err := mapOverviewReview(data)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	estimation, err := mapOverviewEstimation(data)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	checklist, err := mapOverviewChecklist(data, hubs.CredentialReadyCount)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	recent := make([]OverviewRecentLimitSnapshot, 0, len(data.RecentLimits))
	for _, item := range data.RecentLimits {
		mapped, err := mapOverviewRecentLimit(item, now, privacyMode)
		if err != nil {
			return OverviewSnapshot{}, err
		}
		recent = append(recent, mapped)
	}
	recoveryNotice, err := mapOverviewRecoveryNotice(s.recovery)
	if err != nil {
		return OverviewSnapshot{}, err
	}
	return OverviewSnapshot{
		GeneratedAt: now.Format(time.RFC3339Nano), TimezoneConfirmed: data.TimezoneConfirmed,
		RecoveryNotice: recoveryNotice, Checklist: checklist, Hubs: hubs, Review: review,
		Estimation: estimation, RecentLimits: recent,
		Capacity: OverviewCapacitySnapshot{
			DatabaseSizeBytes: data.DatabaseSizeBytes, RawSnapshotCount: data.RawSnapshotCount,
			OldestSnapshotAt: formatOverviewTime(data.OldestSnapshotAt), LatestSnapshotAt: formatOverviewTime(data.LatestSnapshotAt),
		},
	}, nil
}

func (s *OverviewService) mapHubSummary(ctx context.Context, hubs []sqliteadapter.OverviewHub) (OverviewHubSummarySnapshot, error) {
	result := OverviewHubSummarySnapshot{TotalCount: len(hubs)}
	connectionCounts := make(map[string]int)
	currentCollectionCounts := make(map[string]int)
	collectionCounts := make(map[string]int)
	for _, hub := range hubs {
		connection, err := statusPresentation(hub.ConnectionState)
		if err != nil {
			return OverviewHubSummarySnapshot{}, err
		}
		collectionCode := "collection_" + hub.LastCollectionState
		if hub.LastCollectionState == "" {
			collectionCode = "collection_not_run"
		}
		collection, err := statusPresentation(collectionCode)
		if err != nil {
			return OverviewHubSummarySnapshot{}, err
		}
		currentCollectionCode := "collection_idle"
		if hub.CollectionRunning {
			currentCollectionCode = "collection_started"
		}
		currentCollection, err := statusPresentation(currentCollectionCode)
		if err != nil {
			return OverviewHubSummarySnapshot{}, err
		}
		events, err := s.reader.ListCredentialAuditEvents(ctx, hub.ID)
		if err != nil {
			return OverviewHubSummarySnapshot{}, err
		}
		if domain.DeriveCredentialState(toDomainEvents(events)) == domain.CredentialRegistered {
			result.CredentialReadyCount++
		}
		if hub.Enabled {
			result.EnabledCount++
			if hub.CollectionEnabled {
				result.ScheduledCount++
			}
			if overviewHubAbnormal(hub) {
				result.AbnormalCount++
			}
		}
		if hub.CollectionRunning {
			result.RunningCount++
		}
		if hub.LastSuccessAt != nil && (result.LastSuccessAt == "" || hub.LastSuccessAt.Format(time.RFC3339Nano) > result.LastSuccessAt) {
			result.LastSuccessAt = hub.LastSuccessAt.UTC().Format(time.RFC3339Nano)
		}
		connectionCounts[hub.ConnectionState]++
		currentCollectionCounts[currentCollectionCode]++
		collectionCounts[collectionCode]++
		result.Items = append(result.Items, OverviewHubSnapshot{
			ID: hub.ID, DisplayName: hub.DisplayName, Enabled: hub.Enabled, CollectionEnabled: hub.CollectionEnabled,
			Connection: connection, CurrentCollection: currentCollection, LastCollection: collection,
			LastCollectionAt: formatOverviewTime(hub.LastCollectionAt), LastSuccessAt: formatOverviewTime(hub.LastSuccessAt),
			LastFailureAt: formatOverviewTime(hub.LastFailureAt), LastSkippedAt: formatOverviewTime(hub.LastSkippedAt),
		})
	}
	var err error
	result.ConnectionStates, err = mapOverviewStatusCounts(connectionCounts)
	if err != nil {
		return OverviewHubSummarySnapshot{}, err
	}
	result.CurrentCollectionStates, err = mapOverviewStatusCounts(currentCollectionCounts)
	if err != nil {
		return OverviewHubSummarySnapshot{}, err
	}
	result.LastCollectionStates, err = mapOverviewStatusCounts(collectionCounts)
	if err != nil {
		return OverviewHubSummarySnapshot{}, err
	}
	return result, nil
}

func overviewHubAbnormal(hub sqliteadapter.OverviewHub) bool {
	switch hub.ConnectionState {
	case "unreachable", "timeout", "tls_error", "authentication_failed", "unsupported_contract", "invalid_json":
		return true
	}
	return hub.LastCollectionState == "failed"
}

func mapOverviewReview(data sqliteadapter.OverviewData) (OverviewReviewSummarySnapshot, error) {
	action, err := overviewStatusCount("review_action_required", data.ReviewActionCount)
	if err != nil {
		return OverviewReviewSummarySnapshot{}, err
	}
	warning, err := overviewStatusCount("review_warning", data.ReviewWarningCount)
	if err != nil {
		return OverviewReviewSummarySnapshot{}, err
	}
	failure, err := overviewStatusCount("recalculation_failed", data.RecalculationFailureCount)
	if err != nil {
		return OverviewReviewSummarySnapshot{}, err
	}
	actionKinds, err := mapOverviewKindCounts(data.ReviewActionKindCounts)
	if err != nil {
		return OverviewReviewSummarySnapshot{}, err
	}
	warningKinds, err := mapOverviewKindCounts(data.ReviewWarningKindCounts)
	if err != nil {
		return OverviewReviewSummarySnapshot{}, err
	}
	return OverviewReviewSummarySnapshot{
		ActionItems: action, Warnings: warning, RecalculationFailures: failure,
		ActionKinds: actionKinds, WarningKinds: warningKinds,
	}, nil
}

func mapOverviewKindCounts(counts map[string]int) ([]OverviewKindCountSnapshot, error) {
	labels := map[string]string{
		string(domain.ReviewKindIdentificationCandidate):  "サービス・プラン同定候補",
		string(domain.ReviewKindHubAccountCandidate):      "Hub アカウント候補",
		string(domain.ReviewKindUsageCostUnassociated):    "未関連付け利用額",
		string(domain.ReviewKindUsageLimitUnassociated):   "未関連付け利用枠",
		string(domain.ReviewKindLabelChange):              "利用枠名称変更候補",
		string(domain.ReviewKindBillingMonthly):           "billing 月次確認",
		string(domain.ReviewKindPlanHistoryInconsistency): "プラン履歴不整合",
		string(domain.ReviewKindCompleteness):             "活動主体の完全性",
		string(domain.ReviewKindMissingAccountKey):        "accountKey 欠落",
		string(domain.ReviewKindCostDedupeConflict):       "利用額重複排除不整合",
		string(domain.ReviewKindLimitDedupeConflict):      "利用枠重複排除不整合",
	}
	order := []domain.ReviewKind{
		domain.ReviewKindIdentificationCandidate, domain.ReviewKindHubAccountCandidate,
		domain.ReviewKindUsageCostUnassociated, domain.ReviewKindUsageLimitUnassociated,
		domain.ReviewKindLabelChange, domain.ReviewKindBillingMonthly,
		domain.ReviewKindPlanHistoryInconsistency, domain.ReviewKindCompleteness,
		domain.ReviewKindMissingAccountKey, domain.ReviewKindCostDedupeConflict,
		domain.ReviewKindLimitDedupeConflict,
	}
	result := make([]OverviewKindCountSnapshot, 0, len(counts))
	for _, kind := range order {
		code := string(kind)
		if counts[code] == 0 {
			continue
		}
		result = append(result, OverviewKindCountSnapshot{Code: code, Label: labels[code], Count: counts[code]})
	}
	if len(result) != len(counts) {
		return nil, errors.New("overview review count contains an unsupported kind")
	}
	return result, nil
}

func mapOverviewEstimation(data sqliteadapter.OverviewData) (OverviewEstimationSummarySnapshot, error) {
	states, err := mapOverviewStatusCounts(data.EstimationStatusCounts)
	if err != nil {
		return OverviewEstimationSummarySnapshot{}, err
	}
	return OverviewEstimationSummarySnapshot{States: states}, nil
}

func mapOverviewStatusCounts(counts map[string]int) ([]OverviewStatusCountSnapshot, error) {
	order := []string{
		"connected", "not_checked", "unreachable", "timeout", "tls_error", "authentication_failed", "unsupported_contract", "invalid_json",
		"collection_succeeded", "collection_started", "collection_idle", "collection_failed", "collection_skipped", "collection_not_run",
		"verified", "provisional", "insufficient_observations", "unidentifiable", "model_mismatch", "uncomputed", "not_applicable",
	}
	result := make([]OverviewStatusCountSnapshot, 0, len(counts))
	for _, code := range order {
		count := counts[code]
		if count == 0 {
			continue
		}
		item, err := overviewStatusCount(code, count)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if len(result) != len(counts) {
		return nil, fmt.Errorf("overview status count contains an unsupported state")
	}
	return result, nil
}

func overviewStatusCount(code string, count int) (OverviewStatusCountSnapshot, error) {
	status, err := statusPresentation(code)
	if err != nil {
		return OverviewStatusCountSnapshot{}, err
	}
	return OverviewStatusCountSnapshot{Status: status, Count: count}, nil
}

func mapOverviewChecklist(data sqliteadapter.OverviewData, credentialReady int) ([]OverviewChecklistItemSnapshot, error) {
	type item struct{ title, code, route string }
	items := []item{
		{"表示タイムゾーンを確認", checklistCode(data.TimezoneConfirmed, false, false), "/settings"},
		{"Hub と資格情報を登録", checklistCode(len(data.Hubs) > 0 && credentialReady == len(data.Hubs), len(data.Hubs) > 0, false), "/hubs"},
		{"接続確認と初回取得", checklistCode(overviewInitialCollectionComplete(data.Hubs), overviewHasCollection(data.Hubs), overviewHasHubFailure(data.Hubs)), "/hubs"},
		{"サービスとプランを確認", checklistCode(data.ServiceCount > 0 && overviewIdentificationActions(data) == 0, data.ServiceCount > 0, overviewIdentificationActions(data) > 0), "/catalog"},
		{"アカウントと関連付けを確認", checklistCode(data.LogicalAccountCount > 0 && data.LimitAssociationCount > 0 && data.CostAssociationCount > 0, data.LogicalAccountCount > 0 || data.LimitAssociationCount > 0 || data.CostAssociationCount > 0, overviewAssociationActions(data) > 0), "/accounts"},
		{"活動主体の完全性を確認", checklistCode(data.ConfirmedCompletenessCount > 0, data.CostAssociationCount > 0, data.ReviewActionKindCounts[string(domain.ReviewKindCompleteness)] > 0), "/accounts"},
		{"推定状態と未算出理由を確認", checklistCode(overviewEstimationComplete(data), overviewEstimationCount(data) > 0, overviewEstimationNeedsAction(data)), "/overview"},
	}
	result := make([]OverviewChecklistItemSnapshot, 0, len(items))
	actionAssigned := false
	for index, raw := range items {
		status, err := statusPresentation(raw.code)
		if err != nil {
			return nil, err
		}
		actionable := !actionAssigned && raw.code != "complete"
		if actionable {
			actionAssigned = true
		}
		result = append(result, OverviewChecklistItemSnapshot{Step: index + 1, Title: raw.title, Status: status, Route: raw.route, Actionable: actionable})
	}
	return result, nil
}

func checklistCode(complete, started, regressed bool) string {
	if regressed {
		return "action_required"
	}
	if complete {
		return "complete"
	}
	if started {
		return "in_progress"
	}
	return "not_started"
}

func overviewInitialCollectionComplete(hubs []sqliteadapter.OverviewHub) bool {
	enabled := 0
	for _, hub := range hubs {
		if !hub.Enabled {
			continue
		}
		enabled++
		if hub.ConnectionState != "connected" || hub.LastSuccessAt == nil {
			return false
		}
	}
	return enabled > 0
}

func overviewHasCollection(hubs []sqliteadapter.OverviewHub) bool {
	for _, hub := range hubs {
		if hub.LastCollectionState != "" || hub.ConnectionState != "not_checked" {
			return true
		}
	}
	return false
}

func overviewHasHubFailure(hubs []sqliteadapter.OverviewHub) bool {
	for _, hub := range hubs {
		if hub.Enabled && overviewHubAbnormal(hub) {
			return true
		}
	}
	return false
}

func overviewIdentificationActions(data sqliteadapter.OverviewData) int {
	return data.ReviewActionKindCounts[string(domain.ReviewKindIdentificationCandidate)] +
		data.ReviewActionKindCounts[string(domain.ReviewKindLabelChange)] +
		data.ReviewActionKindCounts[string(domain.ReviewKindBillingMonthly)]
}

func overviewAssociationActions(data sqliteadapter.OverviewData) int {
	return data.ReviewActionKindCounts[string(domain.ReviewKindHubAccountCandidate)] +
		data.ReviewActionKindCounts[string(domain.ReviewKindUsageCostUnassociated)] +
		data.ReviewActionKindCounts[string(domain.ReviewKindUsageLimitUnassociated)] +
		data.ReviewActionKindCounts[string(domain.ReviewKindPlanHistoryInconsistency)]
}

func overviewEstimationCount(data sqliteadapter.OverviewData) int {
	count := 0
	for _, value := range data.EstimationStatusCounts {
		count += value
	}
	return count
}

func overviewEstimationNeedsAction(data sqliteadapter.OverviewData) bool {
	return data.EstimationStatusCounts["insufficient_observations"]+data.EstimationStatusCounts["unidentifiable"]+
		data.EstimationStatusCounts["model_mismatch"]+data.EstimationStatusCounts["uncomputed"] > 0
}

func overviewEstimationComplete(data sqliteadapter.OverviewData) bool {
	return overviewEstimationCount(data) > 0 && !overviewEstimationNeedsAction(data)
}

func mapOverviewRecentLimit(item sqliteadapter.OverviewRecentLimit, now time.Time, privacy bool) (OverviewRecentLimitSnapshot, error) {
	if math.IsNaN(item.UsedPercent) || math.IsInf(item.UsedPercent, 0) || item.UsedPercent < 0 || item.UsedPercent > 100 {
		return OverviewRecentLimitSnapshot{}, errors.New("overview limit contains an invalid percentage")
	}
	remaining := 100 - item.UsedPercent
	remainingCode := "remaining_high"
	if remaining < 20 {
		remainingCode = "remaining_low"
	} else if remaining <= 50 {
		remainingCode = "remaining_medium"
	}
	remainingStatus, err := statusPresentation(remainingCode)
	if err != nil {
		return OverviewRecentLimitSnapshot{}, err
	}
	lastIncrease := OverviewTimeSnapshot{OccurredAt: item.LastIncreaseAt.UTC().Format(time.RFC3339Nano), AgeLabel: overviewAgeLabel(now, item.LastIncreaseAt)}
	freshness, err := overviewFreshness(now, item.LatestObservationAt, item.ExpectedInterval)
	if err != nil {
		return OverviewRecentLimitSnapshot{}, err
	}
	resetCode := "reset_unknown"
	resetAt := ""
	if item.ResetsAt != nil {
		resetAt = item.ResetsAt.UTC().Format(time.RFC3339Nano)
		resetCode = "reset_scheduled"
		if !now.Before(*item.ResetsAt) {
			resetCode = "reset_elapsed"
		}
	}
	reset, err := statusPresentation(resetCode)
	if err != nil {
		return OverviewRecentLimitSnapshot{}, err
	}
	result := OverviewRecentLimitSnapshot{
		LogicalAccountID: item.LogicalAccountID, LimitDefinitionID: item.LimitDefinitionID,
		ServiceName: item.ServiceName, AccountName: item.AccountName, LimitName: item.LimitName, CycleType: item.CycleType,
		RemainingPercent: &remaining, RemainingLabel: fmt.Sprintf("%.1f%%", remaining), RemainingDetailLabel: fmt.Sprintf("%.2f%%", remaining), Remaining: remainingStatus,
		ResetAt: resetAt, Reset: reset, LastIncrease: lastIncrease, Freshness: freshness,
	}
	if privacy {
		hidden, err := statusPresentation("privacy_hidden")
		if err != nil {
			return OverviewRecentLimitSnapshot{}, err
		}
		result.AccountName = privacyMask
		result.RemainingPercent = nil
		result.RemainingLabel = privacyMask
		result.RemainingDetailLabel = privacyMask
		result.Remaining = hidden
		result.ResetAt = ""
		result.Reset = hidden
		result.PrivacyMasked = true
	}
	result.AccessibleLabel = fmt.Sprintf("%s、%s、%s、残り %s、%s、利用増加 %s、最新観測 %s",
		result.ServiceName, result.AccountName, result.LimitName, result.RemainingLabel, result.Reset.Label,
		result.LastIncrease.AgeLabel, result.Freshness.AgeLabel)
	result.Tooltip = fmt.Sprintf("残り %s・利用増加 %s（UTC %s）・最新観測 %s（UTC %s）",
		result.RemainingDetailLabel, result.LastIncrease.AgeLabel, result.LastIncrease.OccurredAt,
		result.Freshness.AgeLabel, result.Freshness.ObservationAt)
	if result.ResetAt != "" {
		result.Tooltip += "・リセット UTC " + result.ResetAt
	}
	return result, nil
}

func overviewFreshness(now, observation time.Time, expected time.Duration) (OverviewFreshnessSnapshot, error) {
	if observation.IsZero() || expected <= 0 {
		return OverviewFreshnessSnapshot{}, errors.New("overview freshness requires observation time and expected interval")
	}
	code := "freshness_current"
	reason := fmt.Sprintf("観測時に保存された取得間隔 %s 以内です。", overviewDurationLabel(expected))
	if now.After(observation.Add(expected)) {
		code = "freshness_stale"
		reason = fmt.Sprintf("観測時に保存された取得間隔 %s を超えています。", overviewDurationLabel(expected))
	}
	status, err := statusPresentation(code)
	if err != nil {
		return OverviewFreshnessSnapshot{}, err
	}
	return OverviewFreshnessSnapshot{
		Status: status, Reason: reason, ObservationAt: observation.UTC().Format(time.RFC3339Nano), AgeLabel: overviewAgeLabel(now, observation),
	}, nil
}

func overviewAgeLabel(now, occurred time.Time) string {
	duration := now.Sub(occurred)
	if duration < 0 {
		duration = 0
	}
	return overviewDurationLabel(duration) + "前"
}

func overviewDurationLabel(duration time.Duration) string {
	if duration < time.Minute {
		return "1分未満"
	}
	if duration < time.Hour {
		return fmt.Sprintf("%d分", int(duration/time.Minute))
	}
	if duration < 24*time.Hour {
		return fmt.Sprintf("%d時間", int(duration/time.Hour))
	}
	return fmt.Sprintf("%d日", int(duration/(24*time.Hour)))
}

func mapOverviewRecoveryNotice(recovery domain.RestoreRecoveryResult) (*OverviewRecoveryNoticeSnapshot, error) {
	if recovery.Status == domain.RestoreRecoveryNone {
		return nil, nil
	}
	code := ""
	switch recovery.Status {
	case domain.RestoreRecoveryRolledBack:
		code = "recovery_rolled_back"
	case domain.RestoreRecoveryCommittedCleaned:
		code = "recovery_committed_cleaned"
	default:
		return nil, fmt.Errorf("unsupported restore recovery status %q", recovery.Status)
	}
	status, err := statusPresentation(code)
	if err != nil {
		return nil, err
	}
	return &OverviewRecoveryNoticeSnapshot{Status: status, ArtifactSHA256: recovery.ArtifactSHA256}, nil
}

func formatOverviewTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
