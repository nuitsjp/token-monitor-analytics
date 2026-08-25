package domain

import (
	"strings"
	"testing"
	"time"
)

func TestHubAccountCandidateRequiresNonEmptyAccountKey(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	candidate := HubAccountCandidate{ID: "candidate", HubID: "hub", ServiceID: "service", DisplayName: "Only display name", CreatedAt: now, UpdatedAt: now}
	if err := candidate.Validate(); err == nil || !strings.Contains(err.Error(), "account key") {
		t.Fatalf("empty account key validation error = %v", err)
	}
}

func TestPlanHistoryUsesHalfOpenPeriods(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	end := now.Add(time.Hour)
	history := PlanHistory{ID: "history", LogicalAccountID: "account", PlanVersionID: "version", ValidFrom: now, ValidTo: &end, CreatedAt: now, UpdatedAt: now}
	if err := history.Validate(); err != nil {
		t.Fatal(err)
	}
	reverse := now.Add(-time.Minute)
	history.ValidTo = &reverse
	if err := history.Validate(); err == nil || !strings.Contains(err.Error(), "period") {
		t.Fatalf("reverse period validation error = %v", err)
	}
}
