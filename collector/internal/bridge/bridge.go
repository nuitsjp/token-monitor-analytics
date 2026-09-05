package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
	"token-monitor-analytics/collector/internal/config"
	"token-monitor-analytics/collector/internal/hub"
	"token-monitor-analytics/collector/internal/outbox"
)

func newID() (string, error) {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	return hex.EncodeToString(b), nil
}
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func jitter(d time.Duration) time.Duration {
	n, e := rand.Int(rand.Reader, big.NewInt(500))
	if e == nil {
		return d + time.Duration(n.Int64())*time.Millisecond
	}
	return d
}

// Run owns exactly one spool and one subscriber per Hub. It never opens an inbound port.
func Run(ctx context.Context, c config.Config, log *slog.Logger) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	box, e := outbox.Open(c.SpoolDir, c.MaxSpoolBytes)
	if e != nil {
		return e
	}
	client := hub.NewHTTPClient()
	defer client.CloseIdleConnections()
	errs := make(chan error, len(c.Hubs)+1)
	var wg sync.WaitGroup
	start := func(fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := fn(); e != nil {
				select {
				case errs <- e:
				default:
				}
			}
		}()
	}
	for _, h := range c.Hubs {
		h := h
		start(func() error { return subscribe(ctx, c, h, client, box, log) })
	}
	start(func() error { return upload(ctx, c, client, box, log) })
	select {
	case <-ctx.Done():
		e = nil
	case e = <-errs:
	}
	cancel()
	wg.Wait()
	return e
}
func subscribe(ctx context.Context, c config.Config, h config.Hub, cl *http.Client, b *outbox.Box, log *slog.Logger) error {
	secret, e := config.Secret(h.SecretEnv)
	if e != nil {
		return e
	}
	backoff := time.Second
	for ctx.Err() == nil {
		stream, e := newID()
		if e != nil {
			return e
		}
		valid := false
		var localErr error
		e = hub.Stream(ctx, cl, h.URL, secret, time.Duration(c.IdleSeconds)*time.Second, func() { log.Info("SSE connected", "hub", h.ID) }, func(event hub.Event) error {
			if event.Name != "snapshot" && event.Name != "stats" {
				return nil
			}
			id, e := newID()
			if e != nil {
				localErr = e
				return e
			}
			o, e := hub.Compact(event, h.ID, stream, id, time.Now())
			if e != nil {
				localErr = e
				return e
			}
			for {
				e = b.Put(o)
				if !errors.Is(e, outbox.ErrFull) {
					break
				}
				log.Warn("outbox full; pausing receiver while uploader drains", "hub", h.ID)
				if !sleep(ctx, time.Second) {
					return ctx.Err()
				}
			}
			if e != nil {
				localErr = e
				return e
			}
			valid = true
			return nil
		})
		if ctx.Err() != nil {
			return nil
		}
		if localErr != nil {
			return fmt.Errorf("hub %s: %w", h.ID, localErr)
		}
		if hub.Permanent(e) {
			return fmt.Errorf("hub %s: %w", h.ID, e)
		}
		// Do not log URLs/bodies/credentials from upstream network errors.
		log.Warn("SSE disconnected; reconnecting with a new stream ID", "hub", h.ID, "delay_seconds", backoff.Seconds())
		if valid {
			backoff = time.Second
		}
		if !sleep(ctx, jitter(backoff)) {
			return nil
		}
		if backoff < 30*time.Second {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
	return nil
}

type Batch struct {
	SchemaVersion int               `json:"schemaVersion"`
	Events        []hub.Observation `json:"events"`
}

func Send(ctx context.Context, cl *http.Client, origin, token string, items []outbox.Item) error {
	es := make([]hub.Observation, len(items))
	for i, v := range items {
		es[i] = v.Observation
	}
	raw, e := json.Marshal(Batch{1, es})
	if e != nil {
		return e
	}
	timeout, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(timeout, http.MethodPost, strings.TrimSuffix(origin, "/")+"/api/ingest", bytes.NewReader(raw))
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	r, e := cl.Do(req)
	if e != nil {
		return errors.New("analytics network failure")
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return &hub.HTTPError{Status: r.StatusCode}
	}
	var a struct {
		OK    bool     `json:"ok"`
		Acked []string `json:"acked"`
	}
	if e = json.NewDecoder(io.LimitReader(r.Body, 65536)).Decode(&a); e != nil || !a.OK {
		return errors.New("invalid analytics acknowledgement")
	}
	set := map[string]bool{}
	for _, id := range a.Acked {
		set[id] = true
	}
	for _, i := range items {
		if !set[i.Observation.EventID] {
			return errors.New("analytics did not acknowledge every item")
		}
	}
	return nil
}
func upload(ctx context.Context, c config.Config, cl *http.Client, b *outbox.Box, log *slog.Logger) error {
	token, e := config.Secret(c.IngestTokenEnv)
	if e != nil {
		return e
	}
	backoff := time.Second
	for ctx.Err() == nil {
		items, e := b.Peek(c.BatchSize)
		if e != nil {
			return e
		}
		if len(items) == 0 {
			if !sleep(ctx, time.Duration(c.FlushSeconds)*time.Second) {
				return nil
			}
			continue
		}
		e = Send(ctx, cl, c.AnalyticsURL, token, items)
		if ctx.Err() != nil {
			return nil
		}
		if e != nil {
			if hub.Permanent(e) {
				return fmt.Errorf("analytics rejected upload; outbox retained: %w", e)
			}
			log.Warn("upload failed; retaining outbox", "pending_bytes", b.Bytes(), "retry_seconds", backoff.Seconds())
			if !sleep(ctx, jitter(backoff)) {
				return nil
			}
			if backoff < 30*time.Second {
				backoff = min(backoff*2, 30*time.Second)
			}
			continue
		}
		if e = b.Ack(items); e != nil {
			return e
		}
		backoff = time.Second
		log.Info("uploaded", "events", len(items), "pending_bytes", b.Bytes())
	}
	return nil
}
