package sqlite

import (
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestP2VIS01CollectionDeviceAtUsesConfirmedSwitchRecord(t *testing.T) {
	t.Parallel()
	boundary := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	switches := []domain.HubSwitch{{
		ID: "switch", OldHubID: "hub", OldDeviceID: "record-old", NewHubID: "hub", NewDeviceID: "record-new",
		CollectionDeviceID: "collector", SwitchedAt: boundary,
	}}
	if got := collectionDeviceAt(switches, "hub", "record-old", boundary.Add(-time.Minute)); got != "collector" {
		t.Fatalf("P2-VIS-01 collection device before switch = %q", got)
	}
	if got := collectionDeviceAt(switches, "hub", "record-new", boundary); got != "collector" {
		t.Fatalf("P2-VIS-01 collection device at switch = %q", got)
	}
	if got := collectionDeviceAt(switches, "other-hub", "record-new", boundary); got != "" {
		t.Fatalf("P2-VIS-01 unrelated Hub received collection device = %q", got)
	}
}
