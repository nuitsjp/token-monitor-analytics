package hub

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

func TestCompactRemovesSensitiveAndHeavyFields(t *testing.T) {
	raw := []byte(`{"type":"stats","at":"2026-09-05T00:00:00Z","stats":{"updatedAt":"2026-09-05T00:00:00Z","periods":{"allTime":{"costUsd":12,"clientCosts":{"claude":12},"sessions":{"private":"secret"}}},"devices":[],"limits":{"providers":[{"provider":"claude","accountEmail":"private@example.com","accountKey":"hash","status":"ok","stale":false,"windows":[]}]}}}`)
	o, e := Compact(Event{"snapshot", raw}, "a", "s", "e", time.Date(2026, 9, 5, 0, 0, 0, 0, time.UTC))
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(o)
	if bytes.Contains(b, []byte("private")) || bytes.Contains(b, []byte("sessions")) {
		t.Fatal(string(b))
	}
	if *o.Stats.Periods["allTime"].CostUSD != 12 {
		t.Fatal("cost changed")
	}
}
func TestCompactRejectsMissingEnvelope(t *testing.T) {
	if _, e := Compact(Event{"snapshot", []byte(`{}`)}, "a", "s", "e", time.Now()); e == nil {
		t.Fatal("accepted invalid envelope")
	}
}
