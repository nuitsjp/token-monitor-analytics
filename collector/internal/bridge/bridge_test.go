package bridge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"token-monitor-analytics/collector/internal/hub"
	"token-monitor-analytics/collector/internal/outbox"
)

func TestSendAuthenticatedAcknowledged(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ingest" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("invalid request")
		}
		var b Batch
		if e := json.NewDecoder(r.Body).Decode(&b); e != nil || b.SchemaVersion != 1 {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true,"acked":["id"]}`))
	}))
	defer server.Close()
	e := Send(context.Background(), server.Client(), server.URL, "secret", []outbox.Item{{Observation: hub.Observation{EventID: "id"}}})
	if e != nil {
		t.Fatal(e)
	}
}
func TestSendMissingAckMustRetry(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"ok":true,"acked":[]}`)) }))
	defer s.Close()
	if e := Send(context.Background(), s.Client(), s.URL, "secret", []outbox.Item{{Observation: hub.Observation{EventID: "id"}}}); e == nil {
		t.Fatal("accepted partial ack")
	}
}
func TestUploadFailureKeepsOutbox(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer s.Close()
	b, _ := outbox.Open(t.TempDir(), 1<<20)
	b.Put(hub.Observation{EventID: "id"})
	items, _ := b.Peek(2)
	if e := Send(context.Background(), s.Client(), s.URL, "secret", items); e == nil {
		t.Fatal("503 accepted")
	}
	left, _ := b.Peek(2)
	if len(left) != 1 {
		t.Fatal("unsent data removed")
	}
}
func TestHTTPRedirectDoesNotLeakToken(t *testing.T) {
	var leaked bool
	dst := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
	defer dst.Close()
	src := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, dst.URL, 302) }))
	defer src.Close()
	e := Send(context.Background(), hub.NewHTTPClient(), src.URL, "secret", []outbox.Item{{Observation: hub.Observation{EventID: "id"}}})
	if e == nil || leaked {
		t.Fatal("redirect followed")
	}
}
