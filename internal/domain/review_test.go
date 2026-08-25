package domain

import (
	"strings"
	"testing"
	"time"
)

func TestReviewFilterUsesHalfOpenPeriodAndKnownVocabulary(t *testing.T) {
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	to := from.Add(time.Hour)
	if err := (ReviewFilter{From: &from, To: &to, Kind: ReviewKindCompleteness, State: ReviewStateMissing, Impact: ReviewImpactCalculationIntervalImpossible}).Validate(); err != nil {
		t.Fatalf("valid filter rejected: %v", err)
	}
	if err := (ReviewFilter{From: &to, To: &from}).Validate(); err == nil {
		t.Fatal("reversed review period was accepted")
	}
	if err := (ReviewFilter{Kind: ReviewKind("unsupported")}).Validate(); err == nil || !strings.Contains(err.Error(), "kind") {
		t.Fatalf("unknown kind error = %v", err)
	}
}

func TestReviewItemRejectsInvalidBounds(t *testing.T) {
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	item := ReviewItem{ID: "review", Kind: ReviewKindCompleteness, State: ReviewStateMissing, Impact: ReviewImpactCalculationIntervalImpossible, FirstObservedAt: now, LastObservedAt: now, Count: 1}
	if err := item.Validate(); err != nil {
		t.Fatalf("valid review item rejected: %v", err)
	}
	item.LastObservedAt = now.Add(-time.Minute)
	if err := item.Validate(); err == nil {
		t.Fatal("reversed review item bounds were accepted")
	}
}
