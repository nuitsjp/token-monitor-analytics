package domain

import (
	"errors"
	"testing"
	"time"
)

func TestPurgeSelectionRequiresExplicitHubChoiceAndHalfOpenPeriod(t *testing.T) {
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	end := now.Add(time.Hour)
	t.Run("Hub set and half-open completion interval", func(t *testing.T) {
		if err := (PurgeSelection{}).Validate(); !errors.Is(err, ErrPurgeSelectionHubs) {
			t.Fatalf("empty selection error = %v", err)
		}
		if err := (PurgeSelection{AllHubs: true}).Validate(); err != nil {
			t.Fatalf("all-hub unbounded selection rejected: %v", err)
		}
		if err := (PurgeSelection{AllHubs: true, Start: &now, End: &end}).Validate(); err != nil {
			t.Fatalf("all-hub selection rejected: %v", err)
		}
		if err := (PurgeSelection{HubIDs: []string{"hub"}, Start: &end, End: &now}).Validate(); !errors.Is(err, ErrPurgeSelectionRange) {
			t.Fatalf("reversed period error = %v", err)
		}
		selection, err := (PurgeSelection{HubIDs: []string{" hub-b ", "hub-a"}, Start: &now, End: &end}).Normalized()
		if err != nil || selection.HubIDs[0] != "hub-a" || selection.HubIDs[1] != "hub-b" || !selection.Start.Equal(now) || !selection.End.Equal(end) {
			t.Fatalf("normalized selection = %#v, error = %v", selection, err)
		}
	})
}
