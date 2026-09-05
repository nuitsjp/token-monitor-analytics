package hub

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReadSSE(t *testing.T) {
	for _, sep := range []string{"\n", "\r\n", "\r"} {
		t.Run(fmt.Sprintf("separator_%q", sep), func(t *testing.T) {
			input := strings.Join([]string{"\ufeff: hb", "event: snapshot", "data: {", "data:   \"type\":\"stats\"", "data: }", "", "event: stats", "data: {}", "", ""}, sep)
			var out []Event
			e := ReadSSE(strings.NewReader(input), func(v Event) error { out = append(out, v); return nil })
			if !errors.Is(e, io.EOF) {
				t.Fatal(e)
			}
			if len(out) != 2 || out[0].Name != "snapshot" || string(out[0].Data) != "{\n  \"type\":\"stats\"\n}" {
				t.Fatalf("%#v", out)
			}
		})
	}
}
func TestPartialFrameDiscarded(t *testing.T) {
	count := 0
	_ = ReadSSE(strings.NewReader("event: stats\ndata: {}\n"), func(Event) error { count++; return nil })
	if count != 0 {
		t.Fatal("partial frame dispatched")
	}
}
func TestHeartbeatOnly(t *testing.T) {
	count := 0
	_ = ReadSSE(strings.NewReader(": hb\n\n: hb\n\n"), func(Event) error { count++; return nil })
	if count != 0 {
		t.Fatal(count)
	}
}
func TestSSELimit(t *testing.T) {
	e := ReadSSE(strings.NewReader("data: "+strings.Repeat("x", MaxEventBytes)+"\n\n"), func(Event) error { return nil })
	if e == nil || errors.Is(e, io.EOF) {
		t.Fatal("oversize accepted")
	}
}
func TestStreamAuthorization(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/stats/stream" || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = fmt.Fprint(w, "event: snapshot\ndata: {}\n\n")
	}))
	defer srv.Close()
	got := false
	e := Stream(context.Background(), NewHTTPClient(), srv.URL, "test-secret", time.Second, nil, func(v Event) error { got = true; return io.EOF })
	if !got || !errors.Is(e, io.EOF) {
		t.Fatalf("got=%v error=%v", got, e)
	}
}
func TestStreamUnauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer srv.Close()
	e := Stream(context.Background(), NewHTTPClient(), srv.URL, "test", time.Second, nil, func(Event) error { return nil })
	if !Permanent(e) {
		t.Fatal(e)
	}
}
func TestNoRedirects(t *testing.T) {
	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer srv.Close()
	e := Stream(context.Background(), NewHTTPClient(), srv.URL, "test", time.Second, nil, func(Event) error { return nil })
	if e == nil || hit {
		t.Fatalf("redirect followed: %v", e)
	}
}
func TestIdleStreamCloses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, ": hb\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	start := time.Now()
	e := Stream(ctx, NewHTTPClient(), srv.URL, "test", 90*time.Millisecond, nil, func(Event) error { return nil })
	if e == nil || time.Since(start) > time.Second {
		t.Fatalf("idle watchdog failed: %v", e)
	}
}
func TestSecretValidation(t *testing.T) {
	for _, s := range []string{"", "x\r\ny"} {
		e := Stream(context.Background(), NewHTTPClient(), "http://127.0.0.1:9", s, time.Second, nil, func(Event) error { return nil })
		if e == nil {
			t.Fatal("invalid secret accepted")
		}
	}
}
