package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

// ReviewReader is the read-only port for the M04 cross-domain list. The
// adapter owns canonical-state derivation and cursor ordering; the usecase
// keeps the boundary narrow and validates the filter before delegation.
type ReviewReader interface {
	ListReviewItems(context.Context, domain.ReviewFilter) (domain.ReviewPage, error)
}

type ReviewUsecase struct {
	reader ReviewReader
}

func NewReviewUsecase(reader ReviewReader) (*ReviewUsecase, error) {
	if reader == nil {
		return nil, errors.New("review reader is required")
	}
	return &ReviewUsecase{reader: reader}, nil
}

func (u *ReviewUsecase) List(ctx context.Context, filter domain.ReviewFilter) (domain.ReviewPage, error) {
	if u == nil || u.reader == nil {
		return domain.ReviewPage{}, errors.New("review usecase is unavailable")
	}
	filter.From = normalizedReviewTime(filter.From)
	filter.To = normalizedReviewTime(filter.To)
	if err := filter.Validate(); err != nil {
		return domain.ReviewPage{}, err
	}
	page, err := u.reader.ListReviewItems(ctx, filter)
	if err != nil {
		return domain.ReviewPage{}, fmt.Errorf("list review items: %w", err)
	}
	return page, nil
}

func normalizedReviewTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	normalized := value.UTC()
	return &normalized
}
