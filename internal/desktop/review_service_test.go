package desktop

import (
	"context"
	"errors"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type reviewServiceReader struct {
	page   domain.ReviewPage
	err    error
	filter domain.ReviewFilter
}

func (r *reviewServiceReader) ListReviewItems(_ context.Context, filter domain.ReviewFilter) (domain.ReviewPage, error) {
	r.filter = filter
	return r.page, r.err
}

func TestReviewServiceMapsReadOnlyDTOAndHalfOpenBoundaries(t *testing.T) {
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	reader := &reviewServiceReader{page: domain.ReviewPage{Items: []domain.ReviewItem{{
		ID: "review-1", Kind: domain.ReviewKindMissingAccountKey, State: domain.ReviewStateActive,
		Impact: domain.ReviewImpactCalculationIntervalImpossible, HubID: "hub-1", SourceID: "source-1", TargetID: "target-1",
		FirstObservedAt: now, LastObservedAt: now.Add(time.Hour), Count: 2, EvidenceIDs: []string{"observation-1"},
		EstimationExclusionReason: "accountKey is empty",
	}}}}
	service, err := NewReviewServiceWithReader(reader)
	if err != nil {
		t.Fatal(err)
	}
	page, err := service.GetReviewItems(context.Background(), ReviewFilterInput{From: now.Format(time.RFC3339Nano), To: now.Add(2 * time.Hour).Format(time.RFC3339Nano), Kind: string(domain.ReviewKindMissingAccountKey), HubID: "hub-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "review-1" || page.Items[0].LastObservedAt != now.Add(time.Hour).Format(time.RFC3339Nano) {
		t.Fatalf("review DTO = %#v", page)
	}
	if reader.filter.From == nil || !reader.filter.From.Equal(now) || reader.filter.To == nil || !reader.filter.To.Equal(now.Add(2*time.Hour)) {
		t.Fatalf("review filter = %#v", reader.filter)
	}
}

func TestReviewServiceRejectsInvalidDateAndPropagatesReaderError(t *testing.T) {
	readerErr := errors.New("read failed")
	service, err := NewReviewServiceWithReader(&reviewServiceReader{err: readerErr})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetReviewItems(context.Background(), ReviewFilterInput{From: "bad"}); err == nil {
		t.Fatal("invalid date was accepted")
	}
	if _, err := service.GetReviewItems(context.Background(), ReviewFilterInput{}); err == nil || !errors.Is(err, readerErr) {
		t.Fatalf("reader error = %v", err)
	}
}
