// Mock-only, loopback-only, synthetic values. Never a production Hub.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:8765", "loopback listen address")
	disconnect := flag.Int("disconnect-after", 0, "close stream after N frames (0=never)")
	flag.Parse()
	host, _, e := net.SplitHostPort(*addr)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("mock Hub must bind a loopback IP")
	}
	start := time.Now()
	mux := http.NewServeMux()
	snapshot := func() map[string]any {
		now := time.Now().UTC()
		tick := int(time.Since(start) / (3 * time.Second))
		percent := float64(tick%18) * 5
		period := map[string]any{"costUsd": float64(100 + tick*8), "totalTokens": 10000 + tick*500, "clientCosts": map[string]float64{"claude": float64(100 + tick*8)}}
		return map[string]any{"type": "stats", "at": now.Format(time.RFC3339Nano), "stats": map[string]any{
			"updatedAt": now.Format(time.RFC3339Nano), "periods": map[string]any{"today": period, "month": period, "allTime": period},
			"devices": []any{map[string]any{"deviceId": "demo-pc", "updatedAt": now.Format(time.RFC3339Nano), "stale": false, "periods": map[string]any{"allTime": period}}},
			"limits":  map[string]any{"providers": []any{map[string]any{"provider": "claude", "accountKey": "demo-account", "status": "ok", "stale": false, "updatedAt": now.Format(time.RFC3339Nano), "windows": []any{map[string]any{"kind": "weekly", "usedPercent": percent, "resetsAt": start.Add(time.Duration(tick/18+1) * 7 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)}}}}},
		}}
	}
	mux.HandleFunc("/api/stats/stream", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer demo-hub-secret" {
			http.Error(w, "unauthorized", 401)
			return
		}
		f, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "stream unsupported", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		n := 0
		for {
			event := "stats"
			if n == 0 {
				event = "snapshot"
			}
			b, _ := json.Marshal(snapshot())
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
			f.Flush()
			n++
			if *disconnect > 0 && n >= *disconnect {
				return
			}
			select {
			case <-r.Context().Done():
				return
			case <-t.C:
			}
		}
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true,"synthetic":true}`)
	})
	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		srv.Shutdown(c)
	}()
	log.Printf("synthetic Hub at http://%s (secret: demo-hub-secret)", strings.TrimSpace(*addr))
	if e = srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
