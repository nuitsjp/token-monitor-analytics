package domain

import (
	"testing"
	"time"
)

func TestT023LinkingValidationRejectsUnsafeValues(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	end := now.Add(time.Hour)
	cases := []struct {
		name  string
		check func() error
	}{
		{"source requires identity", func() error {
			return (UsageCostSource{HubID: "hub", DeviceID: "device", RawServiceIdentifier: "raw", CreatedAt: now}).Validate()
		}},
		{"association rejects reversed interval", func() error {
			return (UsageCostAssociation{ID: "association", UsageCostSourceID: "source", LogicalAccountID: "account", ValidFrom: end, ValidTo: &now, CreatedAt: now, UpdatedAt: now}).Validate()
		}},
		{"confirmed completeness rejects exclusions", func() error {
			return (UsageCostSourceCompleteness{ID: "completeness", UsageCostSourceID: "source", ValidFrom: now, ValidTo: &end, State: CompletenessConfirmed, ExcludedActivity: []string{"activity"}, CreatedAt: now, UpdatedAt: now}).Validate()
		}},
		{"Hub switch requires an actual change", func() error {
			return (HubSwitch{ID: "switch", OldHubID: "hub", OldDeviceID: "device", NewHubID: "hub", NewDeviceID: "device", CollectionDeviceID: "collector", SwitchedAt: now, CreatedAt: now}).Validate()
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if err := test.check(); err == nil {
				t.Fatal("invalid linking value was accepted")
			}
		})
	}
}
