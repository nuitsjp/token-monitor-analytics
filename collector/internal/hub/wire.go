// Package hub implements the Token Monitor v0.54.0 SSE contract.
package hub

import (
	"encoding/json"
	"errors"
	"time"
)

type Envelope struct {
	Type  string    `json:"type"`
	Stats *Stats    `json:"stats"`
	At    time.Time `json:"at"`
}
type Stats struct {
	UpdatedAt string            `json:"updatedAt"`
	Periods   map[string]Period `json:"periods"`
	Devices   []Device          `json:"devices"`
	Limits    Limits            `json:"limits"`
}
type Period struct {
	CostUSD     *float64            `json:"costUsd"`
	TotalTokens *float64            `json:"totalTokens,omitempty"`
	ClientCosts map[string]*float64 `json:"clientCosts,omitempty"`
}
type Device struct {
	DeviceID  string            `json:"deviceId"`
	UpdatedAt string            `json:"updatedAt"`
	Stale     *bool             `json:"stale"`
	Periods   map[string]Period `json:"periods"`
}
type Limits struct {
	Providers []Provider `json:"providers"`
}
type Provider struct {
	Provider   string   `json:"provider"`
	AccountKey string   `json:"accountKey"`
	UpdatedAt  string   `json:"updatedAt"`
	Status     string   `json:"status"`
	Stale      *bool    `json:"stale"`
	Windows    []Window `json:"windows"`
}
type Window struct {
	Kind        string   `json:"kind"`
	UsedPercent *float64 `json:"usedPercent"`
	ResetsAt    string   `json:"resetsAt"`
}

// Observation intentionally omits session/project/account-email and model details.
// The retained cost fields are upstream values, not recalculated token prices.
type Observation struct {
	SchemaVersion int    `json:"schemaVersion"`
	HubID         string `json:"hubId"`
	EventID       string `json:"eventId"`
	StreamID      string `json:"streamId"`
	Kind          string `json:"kind"`
	ObservedAt    string `json:"observedAt"`
	ReceivedAt    string `json:"receivedAt"`
	Stats         Stats  `json:"stats"`
}

const MaxObservationBytes = 128 << 10

func Compact(e Event, hubID, streamID, eventID string, now time.Time) (Observation, error) {
	var x Envelope
	var o Observation
	if e.Name != "snapshot" && e.Name != "stats" {
		return o, errors.New("unknown SSE event")
	}
	if err := json.Unmarshal(e.Data, &x); err != nil {
		return o, errors.New("invalid Hub JSON")
	}
	if x.Type != "stats" || x.Stats == nil || x.Stats.Periods == nil || x.At.IsZero() {
		return o, errors.New("missing Hub type/stats/periods/at")
	}
	if x.At.After(now.Add(5 * time.Minute)) {
		return o, errors.New("Hub clock is over five minutes ahead")
	}
	// Permit only the three native periods. No secrets/raw provider payloads enter the outbox.
	for k := range x.Stats.Periods {
		if k != "today" && k != "month" && k != "allTime" {
			delete(x.Stats.Periods, k)
		}
	}
	ids := map[string]bool{}
	for i, d := range x.Stats.Devices {
		if d.DeviceID == "" || ids[d.DeviceID] {
			return o, errors.New("empty/duplicate deviceId")
		}
		ids[d.DeviceID] = true
		// Only lifetime client counters are necessary for attributable cost deltas.
		if p, ok := d.Periods["allTime"]; ok {
			x.Stats.Devices[i].Periods = map[string]Period{"allTime": p}
		} else {
			x.Stats.Devices[i].Periods = map[string]Period{}
		}
	}
	if len(x.Stats.Devices) > 64 || len(x.Stats.Limits.Providers) > 64 {
		return o, errors.New("Hub exceeds starter device/account limit")
	}
	for i := range x.Stats.Limits.Providers {
		if x.Stats.Limits.Providers[i].Windows == nil {
			x.Stats.Limits.Providers[i].Windows = []Window{}
		}
	}
	if x.Stats.Devices == nil {
		x.Stats.Devices = []Device{}
	}
	if x.Stats.Limits.Providers == nil {
		x.Stats.Limits.Providers = []Provider{}
	}
	o = Observation{1, hubID, eventID, streamID, e.Name, x.At.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano), *x.Stats}
	b, err := json.Marshal(o)
	if err != nil {
		return o, err
	}
	if len(b) > MaxObservationBytes {
		return o, errors.New("compact event exceeds 128 KiB; reduce source scope")
	}
	return o, nil
}
