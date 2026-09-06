package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"token-monitor-analytics/collector/internal/config"
	"token-monitor-analytics/collector/internal/hub"
	"token-monitor-analytics/collector/internal/outbox"
)

type ConnectionState string

const (
	StateConnecting ConnectionState = "connecting"
	StateConnected  ConnectionState = "connected"
	StateError      ConnectionState = "error"
	StateDisabled   ConnectionState = "disabled"
)

type HubReport struct {
	ID        string          `json:"id"`
	Status    ConnectionState `json:"status"`
	ErrorCode string          `json:"errorCode,omitempty"`
	UpdatedAt string          `json:"updatedAt"`
}

type StatusPayload struct {
	AppliedRevision int         `json:"appliedRevision"`
	Hubs            []HubReport `json:"hubs"`
}

type hubRunner struct {
	hub       config.ResolvedHub
	cancel    context.CancelFunc
	done      chan struct{}
	mu        sync.Mutex
	status    ConnectionState
	errorCode string
	updatedAt time.Time
}

func (r *hubRunner) update(status ConnectionState, errCode string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status = status
	r.errorCode = errCode
	r.updatedAt = time.Now().UTC()
}

func (r *hubRunner) report() HubReport {
	r.mu.Lock()
	defer r.mu.Unlock()
	return HubReport{
		ID:        r.hub.ID,
		Status:    r.status,
		ErrorCode: r.errorCode,
		UpdatedAt: r.updatedAt.Format(time.RFC3339),
	}
}

type HubManager struct {
	mu              sync.Mutex
	hubsPath        string
	analyticsURL    string
	ingestToken     string
	appliedRevision int
	runners         map[string]*hubRunner
	box             *outbox.Box
	client          *http.Client
	log             *slog.Logger
	idleSeconds     int
	notifyCh        chan struct{}
}

func NewHubManager(hubsPath, analyticsURL, ingestToken string, idleSeconds int, box *outbox.Box, client *http.Client, log *slog.Logger) *HubManager {
	return &HubManager{
		hubsPath:        hubsPath,
		analyticsURL:    analyticsURL,
		ingestToken:     ingestToken,
		appliedRevision: -1,
		runners:         make(map[string]*hubRunner),
		box:             box,
		client:          client,
		log:             log,
		idleSeconds:     idleSeconds,
		notifyCh:        make(chan struct{}, 1),
	}
}

func (m *HubManager) triggerNotify() {
	select {
	case m.notifyCh <- struct{}{}:
	default:
	}
}

func (m *HubManager) Run(ctx context.Context) error {
	checkTicker := time.NewTicker(2 * time.Second)
	defer checkTicker.Stop()

	reportTicker := time.NewTicker(15 * time.Second)
	defer reportTicker.Stop()

	m.checkAndApply()
	m.reportStatus(ctx)

	for {
		select {
		case <-ctx.Done():
			m.stopAll()
			return nil
		case <-checkTicker.C:
			if m.checkAndApply() {
				m.reportStatus(ctx)
			}
		case <-reportTicker.C:
			m.reportStatus(ctx)
		case <-m.notifyCh:
			m.reportStatus(ctx)
		}
	}
}

func (m *HubManager) stopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.runners {
		r.cancel()
		<-r.done
	}
	m.runners = make(map[string]*hubRunner)
}

func (m *HubManager) checkAndApply() bool {
	cfg, err := config.LoadHubsConfig(m.hubsPath)
	if err != nil {
		m.log.Warn("failed to load hubs configuration; retaining current state", "error", err)
		return false
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if cfg.Revision == m.appliedRevision {
		return false
	}

	m.log.Info("applying updated hubs configuration", "from_revision", m.appliedRevision, "to_revision", cfg.Revision)

	activeMap := make(map[string]config.ResolvedHub)
	for _, h := range cfg.Hubs {
		if h.Status != config.StatusArchived {
			activeMap[h.ID] = h
		}
	}

	for id, r := range m.runners {
		target, exists := activeMap[id]
		if !exists || target.Status == config.StatusDisabled {
			m.log.Info("stopping hub subscription", "hub", id)
			r.cancel()
			<-r.done
			if !exists {
				delete(m.runners, id)
			} else {
				r.update(StateDisabled, "")
			}
		} else if target.URL != r.hub.URL || target.SecretRef != r.hub.SecretRef || target.Secret != r.hub.Secret {
			m.log.Info("hub credentials or URL changed; restarting subscription", "hub", id)
			r.cancel()
			<-r.done
			delete(m.runners, id)
		} else {
			r.hub.Label = target.Label
		}
	}

	for id, target := range activeMap {
		if target.Status != config.StatusActive {
			continue
		}
		if _, exists := m.runners[id]; !exists {
			m.startRunner(id, target)
		}
	}

	m.appliedRevision = cfg.Revision
	return true
}

func (m *HubManager) startRunner(id string, h config.ResolvedHub) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := &hubRunner{
		hub:       h,
		cancel:    cancel,
		done:      make(chan struct{}),
		status:    StateConnecting,
		updatedAt: time.Now().UTC(),
	}
	m.runners[id] = runner

	go func() {
		defer close(runner.done)
		m.subscribeLoop(ctx, runner)
	}()
}

func (m *HubManager) subscribeLoop(ctx context.Context, r *hubRunner) {
	h := r.hub
	backoff := time.Second

	for ctx.Err() == nil {
		stream, err := newID()
		if err != nil {
			r.update(StateError, "id_generation_failed")
			m.triggerNotify()
			return
		}

		r.update(StateConnecting, "")
		m.triggerNotify()

		valid := false
		var localErr error

		err = hub.Stream(ctx, m.client, h.URL, h.Secret, time.Duration(m.idleSeconds)*time.Second,
			func() {
				r.update(StateConnected, "")
				m.triggerNotify()
				m.log.Info("SSE connected", "hub", h.ID)
			},
			func(event hub.Event) error {
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
					e = m.box.Put(o)
					if !errors.Is(e, outbox.ErrFull) {
						break
					}
					m.log.Warn("outbox full; pausing receiver while uploader drains", "hub", h.ID)
					timer := time.NewTimer(time.Second)
					select {
					case <-ctx.Done():
						timer.Stop()
						return ctx.Err()
					case <-timer.C:
					}
				}
				if e != nil {
					localErr = e
					return e
				}
				valid = true
				return nil
			},
		)

		if ctx.Err() != nil {
			return
		}

		if localErr != nil {
			m.log.Error("hub receiver error", "hub", h.ID, "error", localErr)
			r.update(StateError, "compact_error")
			m.triggerNotify()
			return
		}

		if hub.Permanent(err) {
			m.log.Error("hub authentication or permanent error", "hub", h.ID, "error", err)
			var httpErr *hub.HTTPError
			if errors.As(err, &httpErr) && (httpErr.Status == 401 || httpErr.Status == 403) {
				r.update(StateError, "auth_failed")
			} else {
				r.update(StateError, "permanent_error")
			}
			m.triggerNotify()
			<-ctx.Done()
			return
		}

		r.update(StateError, "network_error")
		m.triggerNotify()

		m.log.Warn("SSE disconnected; reconnecting with new stream ID", "hub", h.ID, "delay_seconds", backoff.Seconds())
		if valid {
			backoff = time.Second
		}
		t := time.NewTimer(jitter(backoff))
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if backoff < 30*time.Second {
			backoff = min(backoff*2, 30*time.Second)
		}
	}
}

func (m *HubManager) reportStatus(ctx context.Context) {
	m.mu.Lock()
	payload := StatusPayload{
		AppliedRevision: m.appliedRevision,
		Hubs:            make([]HubReport, 0, len(m.runners)),
	}
	for _, r := range m.runners {
		payload.Hubs = append(payload.Hubs, r.report())
	}
	m.mu.Unlock()

	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}

	endpoint := strings.TrimSuffix(m.analyticsURL, "/") + "/api/collector/status"
	reqCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+m.ingestToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		m.log.Debug("status report to analytics failed (will retry)", "error", err)
		return
	}
	resp.Body.Close()
}
