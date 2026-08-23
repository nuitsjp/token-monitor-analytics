package app

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"token-monitor-analytics/internal/analytics"
	"token-monitor-analytics/internal/credential"
	"token-monitor-analytics/internal/storage"
)

const defaultIntervalSeconds = 300

type Service struct {
	store       *storage.Store
	credentials credential.Store
	httpClient  *http.Client
	mu          sync.RWMutex
	cancel      context.CancelFunc
	running     bool
	lastError   string
	lastFetch   string
}

type Settings struct {
	HubURL           string `json:"hubUrl"`
	Secret           string `json:"secret,omitempty"`
	SecretConfigured bool   `json:"secretConfigured"`
	IntervalSeconds  int    `json:"intervalSeconds"`
}

type FetchResult struct {
	SnapshotID       int64  `json:"snapshotId"`
	ObservationCount int    `json:"observationCount"`
	FetchedAt        string `json:"fetchedAt"`
	Message          string `json:"message"`
}

type Status struct {
	Configured      bool   `json:"configured"`
	Running         bool   `json:"running"`
	LastError       string `json:"lastError"`
	LastFetchedAt   string `json:"lastFetchedAt"`
	SnapshotCount   int    `json:"snapshotCount"`
	IntervalSeconds int    `json:"intervalSeconds"`
}

func NewService(store *storage.Store, credentials credential.Store) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("storage is required")
	}
	if credentials == nil {
		return nil, fmt.Errorf("credential store is required")
	}
	service := &Service{
		store:       store,
		credentials: credentials,
		httpClient:  &http.Client{Timeout: 30 * time.Second},
	}
	if err := service.migrateLegacySecret(); err != nil {
		return nil, err
	}
	return service, nil
}

func (s *Service) GetSettings() Settings {
	hubURL, interval, err := s.store.GetSettings()
	if err != nil {
		s.setError(err)
	}
	storedSecret, secretFound, credentialErr := s.credentials.Read()
	if credentialErr != nil {
		s.setError(credentialErr)
	}
	secretConfigured := secretFound && storedSecret != ""
	if interval <= 0 {
		interval = defaultIntervalSeconds
	}
	return Settings{HubURL: hubURL, SecretConfigured: secretConfigured, IntervalSeconds: interval}
}

func (s *Service) SaveSettings(settings Settings) error {
	hubURL := strings.TrimSpace(settings.HubURL)
	if hubURL == "" {
		return fmt.Errorf("Hub URL is required")
	}
	interval := settings.IntervalSeconds
	if interval < 10 {
		interval = defaultIntervalSeconds
	}
	if settings.Secret != "" {
		if err := s.credentials.Write(settings.Secret); err != nil {
			return err
		}
	}
	if err := s.store.SaveSettings(hubURL, interval); err != nil {
		return err
	}
	s.mu.Lock()
	s.lastError = ""
	s.mu.Unlock()
	return nil
}

func (s *Service) FetchNow() (FetchResult, error) {
	hubURL, _, err := s.store.GetSettings()
	if err != nil {
		return FetchResult{}, err
	}
	if strings.TrimSpace(hubURL) == "" {
		return FetchResult{}, fmt.Errorf("save a Hub URL before collecting")
	}
	secret, _, err := s.credentials.Read()
	if err != nil {
		return FetchResult{}, err
	}
	return s.fetchAndStore(hubURL, secret)
}

func (s *Service) Start() error {
	hubURL, interval, err := s.store.GetSettings()
	if err != nil {
		return err
	}
	if strings.TrimSpace(hubURL) == "" {
		return fmt.Errorf("save a Hub URL before starting collection")
	}
	if interval < 10 {
		interval = defaultIntervalSeconds
	}
	secret, _, err := s.credentials.Read()
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.running = true
	s.mu.Unlock()
	go func() {
		ticker := time.NewTicker(time.Duration(interval) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := s.fetchAndStore(hubURL, secret); err != nil {
					s.setError(err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return nil
}

func (s *Service) Stop() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.cancel = nil
	s.running = false
	s.mu.Unlock()
}

func (s *Service) GetHistory(limit int) ([]analytics.Observation, error) {
	return s.store.History(limit)
}

func (s *Service) GetStatus() Status {
	hubURL, interval, err := s.store.GetSettings()
	if interval < 10 {
		interval = defaultIntervalSeconds
	}
	count, countErr := s.store.SnapshotCount()
	s.mu.RLock()
	status := Status{Configured: strings.TrimSpace(hubURL) != "", Running: s.running, LastError: s.lastError, LastFetchedAt: s.lastFetch, IntervalSeconds: interval}
	s.mu.RUnlock()
	if err != nil {
		status.LastError = err.Error()
	}
	if countErr == nil {
		status.SnapshotCount = count
	}
	return status
}

func (s *Service) migrateLegacySecret() error {
	legacySecret, err := s.store.LegacySecret()
	if err != nil {
		return fmt.Errorf("read legacy secret: %w", err)
	}
	if legacySecret == "" {
		return nil
	}
	existingSecret, found, err := s.credentials.Read()
	if err != nil {
		return fmt.Errorf("read Windows credential before migration: %w", err)
	}
	if !found || existingSecret == "" {
		if err := s.credentials.Write(legacySecret); err != nil {
			return fmt.Errorf("migrate secret to Windows Credential Manager: %w", err)
		}
	}
	if err := s.store.DeleteLegacySecret(); err != nil {
		return fmt.Errorf("remove legacy secret from SQLite: %w", err)
	}
	return nil
}

func (s *Service) fetchAndStore(hubURL, secret string) (FetchResult, error) {
	raw, fetchedAt, err := analytics.FetchStats(context.Background(), s.httpClient, hubURL, secret)
	if err != nil {
		s.setError(err)
		return FetchResult{}, err
	}
	parsed, parseErr := analytics.ParseAndCalculate(raw, fetchedAt)
	if parseErr != nil {
		_, storeErr := s.store.SaveSnapshot(fetchedAt, strings.TrimRight(hubURL, "/")+"/api/stats", raw, nil)
		if storeErr != nil {
			return FetchResult{}, fmt.Errorf("parse stats: %v; save raw snapshot: %w", parseErr, storeErr)
		}
		s.setError(parseErr)
		return FetchResult{}, parseErr
	}
	snapshotID, err := s.store.SaveSnapshot(fetchedAt, strings.TrimRight(hubURL, "/")+"/api/stats", raw, parsed.Observations)
	if err != nil {
		s.setError(err)
		return FetchResult{}, err
	}
	s.mu.Lock()
	s.lastError = ""
	s.lastFetch = fetchedAt.Format(time.RFC3339Nano)
	s.mu.Unlock()
	return FetchResult{SnapshotID: snapshotID, ObservationCount: len(parsed.Observations), FetchedAt: fetchedAt.Format(time.RFC3339Nano), Message: "snapshot saved"}, nil
}

func (s *Service) setError(err error) {
	s.mu.Lock()
	s.lastError = err.Error()
	s.mu.Unlock()
}
