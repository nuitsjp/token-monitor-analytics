package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

type reviewTestReader struct {
	page   domain.ReviewPage
	err    error
	filter domain.ReviewFilter
}

func (r *reviewTestReader) ListReviewItems(_ context.Context, filter domain.ReviewFilter) (domain.ReviewPage, error) {
	r.filter = filter
	return r.page, r.err
}

func TestReviewUsecaseNormalizesBoundariesAndDelegatesReadOnly(t *testing.T) {
	reader := &reviewTestReader{page: domain.ReviewPage{HasMore: true}}
	uc, err := NewReviewUsecase(reader)
	if err != nil {
		t.Fatal(err)
	}
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.FixedZone("JST", 9*60*60))
	to := from.Add(time.Hour)
	page, err := uc.List(context.Background(), domain.ReviewFilter{From: &from, To: &to, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !page.HasMore || !reader.filter.From.Equal(from.UTC()) || !reader.filter.To.Equal(to.UTC()) {
		t.Fatalf("delegation = %#v", reader.filter)
	}
}

func TestReviewUsecaseRejectsInvalidFilterAndPropagatesReaderError(t *testing.T) {
	reader := &reviewTestReader{err: errors.New("database unavailable")}
	uc, err := NewReviewUsecase(reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uc.List(context.Background(), domain.ReviewFilter{Kind: domain.ReviewKind("invalid")}); err == nil {
		t.Fatal("invalid filter reached reader")
	}
	if _, err := uc.List(context.Background(), domain.ReviewFilter{}); err == nil || !errors.Is(err, reader.err) {
		t.Fatalf("reader error = %v", err)
	}
}
