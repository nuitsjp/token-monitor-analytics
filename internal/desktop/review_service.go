package desktop

import (
	"context"
	"errors"
	"fmt"
	"time"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

// ReviewService is the read-only Wails boundary for M04. It exposes
// navigation identifiers and non-secret evidence only; raw snapshots and
// credentials never cross this boundary.
type ReviewService struct {
	usecase *usecase.ReviewUsecase
}

type ReviewFilterInput struct {
	Cursor string `json:"cursor"`
	Limit  int    `json:"limit"`
	From   string `json:"from"`
	To     string `json:"to"`
	Kind   string `json:"kind"`
	State  string `json:"state"`
	Impact string `json:"impact"`
	HubID  string `json:"hubId"`
}

type ReviewItemSnapshot struct {
	ID                        string   `json:"id"`
	Kind                      string   `json:"kind"`
	State                     string   `json:"state"`
	Impact                    string   `json:"impact"`
	HubID                     string   `json:"hubId"`
	SourceID                  string   `json:"sourceId"`
	TargetID                  string   `json:"targetId"`
	Target                    string   `json:"target"`
	RawLimitServiceIdentifier string   `json:"rawLimitServiceIdentifier"`
	RawReportedPlanName       string   `json:"rawReportedPlanName"`
	AccountKey                string   `json:"accountKey"`
	AccountDisplayName        string   `json:"accountDisplayName"`
	WorkspaceName             string   `json:"workspaceName"`
	DeviceName                string   `json:"deviceName"`
	FirstObservedAt           string   `json:"firstObservedAt"`
	LastObservedAt            string   `json:"lastObservedAt"`
	TargetPeriodStart         string   `json:"targetPeriodStart"`
	TargetPeriodEnd           string   `json:"targetPeriodEnd"`
	Count                     int      `json:"count"`
	EvidenceIDs               []string `json:"evidenceIds"`
	EstimationExclusionReason string   `json:"estimationExclusionReason"`
}

type ReviewPage struct {
	Items      []ReviewItemSnapshot `json:"items"`
	NextCursor string               `json:"nextCursor"`
	HasMore    bool                 `json:"hasMore"`
}

func NewReviewService(lifecycle *sqliteadapter.Lifecycle) (*ReviewService, error) {
	if lifecycle == nil {
		return nil, errors.New("review service lifecycle is required")
	}
	return NewReviewServiceWithReader(lifecycle)
}

func NewReviewServiceWithReader(reader usecase.ReviewReader) (*ReviewService, error) {
	reviewUsecase, err := usecase.NewReviewUsecase(reader)
	if err != nil {
		return nil, err
	}
	return &ReviewService{usecase: reviewUsecase}, nil
}

func (s *ReviewService) GetReviewItems(ctx context.Context, input ReviewFilterInput) (ReviewPage, error) {
	if s == nil || s.usecase == nil {
		return ReviewPage{}, errors.New("review service is unavailable")
	}
	from, err := parseReviewBoundary(input.From)
	if err != nil {
		return ReviewPage{}, fmt.Errorf("invalid review from date: %w", err)
	}
	to, err := parseReviewBoundary(input.To)
	if err != nil {
		return ReviewPage{}, fmt.Errorf("invalid review to date: %w", err)
	}
	page, err := s.usecase.List(ctx, domain.ReviewFilter{
		Cursor: input.Cursor, Limit: input.Limit, From: from, To: to,
		Kind: domain.ReviewKind(input.Kind), State: domain.ReviewState(input.State),
		Impact: domain.ReviewImpact(input.Impact), HubID: input.HubID,
	})
	if err != nil {
		return ReviewPage{}, err
	}
	result := ReviewPage{NextCursor: page.NextCursor, HasMore: page.HasMore, Items: make([]ReviewItemSnapshot, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, reviewItemSnapshot(item))
	}
	return result, nil
}

func reviewItemSnapshot(item domain.ReviewItem) ReviewItemSnapshot {
	return ReviewItemSnapshot{
		ID: item.ID, Kind: string(item.Kind), State: string(item.State), Impact: string(item.Impact),
		HubID: item.HubID, SourceID: item.SourceID, TargetID: item.TargetID, Target: item.Target,
		RawLimitServiceIdentifier: item.RawLimitServiceIdentifier, RawReportedPlanName: item.RawReportedPlanName,
		AccountKey: item.AccountKey, AccountDisplayName: item.AccountDisplayName,
		WorkspaceName: item.WorkspaceName, DeviceName: item.DeviceName,
		FirstObservedAt:   item.FirstObservedAt.UTC().Format(time.RFC3339Nano),
		LastObservedAt:    item.LastObservedAt.UTC().Format(time.RFC3339Nano),
		TargetPeriodStart: formatOptionalReviewTime(item.TargetPeriodStart),
		TargetPeriodEnd:   formatOptionalReviewTime(item.TargetPeriodEnd),
		Count:             item.Count, EvidenceIDs: append([]string(nil), item.EvidenceIDs...),
		EstimationExclusionReason: item.EstimationExclusionReason,
	}
}

func parseReviewBoundary(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, errors.New("expected RFC3339 timestamp")
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func formatOptionalReviewTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}
