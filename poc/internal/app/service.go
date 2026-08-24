package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"token-monitor-analytics/internal/analytics"
	"token-monitor-analytics/internal/credential"
	"token-monitor-analytics/internal/storage"
)

const defaultIntervalSeconds = 300

type Service struct {
	store            *storage.Store
	credentials      credential.Store
	cloudCredentials credential.Store
	httpClient       *http.Client
	mu               sync.RWMutex
	cancel           context.CancelFunc
	running          bool
	lastError        string
	lastFetch        string
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

type SubscriptionInput struct {
	Provider        string  `json:"provider"`
	AccountKey      string  `json:"accountKey"`
	AccountLabel    string  `json:"accountLabel"`
	PlanName        string  `json:"planName"`
	MonthlyPriceUSD float64 `json:"monthlyPriceUsd"`
}

type SubscriptionMetric struct {
	ID                          int64    `json:"id"`
	Provider                    string   `json:"provider"`
	AccountKey                  string   `json:"accountKey"`
	AccountLabel                string   `json:"accountLabel"`
	PlanName                    string   `json:"planName"`
	MonthlyPriceUSD             float64  `json:"monthlyPriceUsd"`
	ActualUsageUSD              *float64 `json:"actualUsageUsd"`
	EstimatedLimitUSD           *float64 `json:"estimatedLimitUsd"`
	ActualValueMultiplier       *float64 `json:"actualValueMultiplier"`
	EstimatedMaxValueMultiplier *float64 `json:"estimatedMaxValueMultiplier"`
	DataQuality                 string   `json:"dataQuality"`
}

type Dashboard struct {
	PeriodKey     string                     `json:"periodKey"`
	TotalTokens   float64                    `json:"totalTokens"`
	TotalCostUSD  float64                    `json:"totalCostUsd"`
	Subscriptions []SubscriptionMetric       `json:"subscriptions"`
	Trend         []analytics.Observation    `json:"trend"`
	Breakdowns    []analytics.UsageBreakdown `json:"breakdowns"`
}

type CloudSettings struct {
	URL              string `json:"url"`
	Secret           string `json:"secret,omitempty"`
	SecretConfigured bool   `json:"secretConfigured"`
	Enabled          bool   `json:"enabled"`
	DeviceID         string `json:"deviceId"`
}

type CloudSyncResult struct {
	UploadedSnapshots int    `json:"uploadedSnapshots"`
	AcceptedThrough   int64  `json:"acceptedThrough"`
	SyncedAt          string `json:"syncedAt"`
}

type BackupEnvelope struct {
	Version     int                `json:"version"`
	GeneratedAt string             `json:"generatedAt"`
	Checksum    string             `json:"checksum"`
	Data        storage.BackupData `json:"data"`
}

func NewService(store *storage.Store, credentials, cloudCredentials credential.Store) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("storage is required")
	}
	if credentials == nil {
		return nil, fmt.Errorf("credential store is required")
	}
	if cloudCredentials == nil {
		return nil, fmt.Errorf("cloud credential store is required")
	}
	service := &Service{
		store:            store,
		credentials:      credentials,
		cloudCredentials: cloudCredentials,
		httpClient:       &http.Client{Timeout: 30 * time.Second},
	}
	if err := service.migrateLegacySecret(); err != nil {
		return nil, err
	}
	if err := service.ensureDeviceID(); err != nil {
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
					continue
				}
				cloudConfig, err := s.store.GetCloudConfig()
				if err != nil {
					s.setError(err)
				} else if cloudConfig.Enabled {
					if _, err := s.SyncCloudNow(); err != nil {
						s.setError(err)
					}
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

func (s *Service) GetAccounts() ([]storage.AccountOption, error) {
	return s.store.Accounts()
}

func (s *Service) SaveSubscription(input SubscriptionInput) (storage.Subscription, error) {
	subscription := storage.Subscription{
		Provider:        strings.TrimSpace(input.Provider),
		AccountKey:      strings.TrimSpace(input.AccountKey),
		AccountLabel:    strings.TrimSpace(input.AccountLabel),
		PlanName:        strings.TrimSpace(input.PlanName),
		MonthlyPriceUSD: input.MonthlyPriceUSD,
	}
	if subscription.Provider == "" || subscription.AccountKey == "" {
		return storage.Subscription{}, fmt.Errorf("provider and account are required")
	}
	if subscription.AccountLabel == "" {
		subscription.AccountLabel = subscription.AccountKey
	}
	if subscription.PlanName == "" {
		return storage.Subscription{}, fmt.Errorf("plan name is required")
	}
	if subscription.MonthlyPriceUSD <= 0 || math.IsNaN(subscription.MonthlyPriceUSD) || math.IsInf(subscription.MonthlyPriceUSD, 0) {
		return storage.Subscription{}, fmt.Errorf("monthly price must be a positive USD amount")
	}
	return s.store.SaveSubscription(subscription)
}

func (s *Service) DeleteSubscription(id int64) error {
	if id <= 0 {
		return fmt.Errorf("subscription id is required")
	}
	return s.store.DeleteSubscription(id)
}

func (s *Service) GetDashboard() (Dashboard, error) {
	subscriptions, err := s.store.Subscriptions()
	if err != nil {
		return Dashboard{}, err
	}
	history, err := s.store.History(1000)
	if err != nil {
		return Dashboard{}, err
	}
	dashboard := Dashboard{PeriodKey: "month", Trend: history}
	raw, err := s.store.LatestSnapshotRaw()
	if err != nil {
		return Dashboard{}, err
	}
	analysis := analytics.StatsAnalysis{ProviderCosts: map[string]float64{}, ProviderAccountCounts: map[string]int{}}
	if len(raw) > 0 {
		analysis, err = analytics.AnalyzeStats(raw, "month")
		if err != nil {
			return Dashboard{}, err
		}
		dashboard.TotalTokens = analysis.TotalTokens
		dashboard.TotalCostUSD = analysis.TotalCostUSD
		dashboard.Breakdowns = analysis.Breakdowns
	}
	latestEstimate := make(map[string]float64)
	for _, observation := range history {
		key := subscriptionKey(observation.Provider, observation.AccountKey)
		if _, exists := latestEstimate[key]; !exists && observation.CalculationStatus == "ok" && observation.EstimatedLimitUSD > 0 {
			latestEstimate[key] = observation.EstimatedLimitUSD
		}
	}
	for _, subscription := range subscriptions {
		metric := SubscriptionMetric{
			ID: subscription.ID, Provider: subscription.Provider, AccountKey: subscription.AccountKey,
			AccountLabel: subscription.AccountLabel, PlanName: subscription.PlanName,
			MonthlyPriceUSD: subscription.MonthlyPriceUSD,
		}
		providerKey := strings.ToLower(subscription.Provider)
		var quality []string
		accountCount := analysis.ProviderAccountCounts[providerKey]
		if accountCount > 1 {
			quality = append(quality, "ambiguous_account_cost")
		} else if accountCount == 0 {
			quality = append(quality, "missing_provider_account")
		} else if usage, ok := analysis.ProviderCosts[providerKey]; ok {
			metric.ActualUsageUSD = floatPointer(usage)
			metric.ActualValueMultiplier = floatPointer(usage / subscription.MonthlyPriceUSD)
		} else {
			quality = append(quality, "missing_monthly_provider_cost")
		}
		if estimate, ok := latestEstimate[subscriptionKey(subscription.Provider, subscription.AccountKey)]; ok {
			metric.EstimatedLimitUSD = floatPointer(estimate)
			metric.EstimatedMaxValueMultiplier = floatPointer(estimate / subscription.MonthlyPriceUSD)
		} else {
			quality = append(quality, "missing_exact_estimate")
		}
		if len(quality) == 0 {
			metric.DataQuality = "ok"
		} else {
			metric.DataQuality = strings.Join(quality, ",")
		}
		dashboard.Subscriptions = append(dashboard.Subscriptions, metric)
	}
	return dashboard, nil
}

func (s *Service) ExportJSON() (string, error) {
	subscriptions, err := s.store.Subscriptions()
	if err != nil {
		return "", err
	}
	history, err := s.store.AllHistory()
	if err != nil {
		return "", err
	}
	payload := struct {
		GeneratedAt   string                  `json:"generatedAt"`
		Subscriptions []storage.Subscription  `json:"subscriptions"`
		Observations  []analytics.Observation `json:"observations"`
	}{time.Now().UTC().Format(time.RFC3339Nano), subscriptions, history}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func (s *Service) ExportCSV() (string, error) {
	subscriptions, err := s.store.Subscriptions()
	if err != nil {
		return "", err
	}
	history, err := s.store.AllHistory()
	if err != nil {
		return "", err
	}
	prices := make(map[string]float64)
	for _, subscription := range subscriptions {
		prices[subscriptionKey(subscription.Provider, subscription.AccountKey)] = subscription.MonthlyPriceUSD
	}
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	_ = writer.Write([]string{"observed_at", "provider", "account_key", "account_label", "window_kind", "period_key", "usage_usd", "utilization_percent", "estimated_limit_usd", "monthly_price_usd", "calculation_status", "calculation_note"})
	for _, observation := range history {
		price := prices[subscriptionKey(observation.Provider, observation.AccountKey)]
		_ = writer.Write([]string{
			observation.ObservedAt, observation.Provider, observation.AccountKey, observation.AccountLabel,
			observation.WindowKind, observation.PeriodKey, formatFloat(observation.UsageUSD),
			formatFloat(observation.UtilizationPercent), formatFloat(observation.EstimatedLimitUSD),
			formatFloat(price), observation.CalculationStatus, observation.CalculationNote,
		})
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return "", err
	}
	return "\uFEFF" + buffer.String(), nil
}

func (s *Service) GetCloudSettings() CloudSettings {
	config, err := s.store.GetCloudConfig()
	if err != nil {
		s.setError(err)
	}
	storedSecret, found, credentialErr := s.cloudCredentials.Read()
	if credentialErr != nil {
		s.setError(credentialErr)
	}
	return CloudSettings{
		URL: config.URL, Enabled: config.Enabled, DeviceID: config.DeviceID,
		SecretConfigured: found && storedSecret != "",
	}
}

func (s *Service) SaveCloudSettings(settings CloudSettings) error {
	cloudURL := strings.TrimRight(strings.TrimSpace(settings.URL), "/")
	if settings.Enabled {
		parsed, err := url.Parse(cloudURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("cloud URL must be an http or https URL")
		}
	}
	if settings.Secret != "" {
		if err := s.cloudCredentials.Write(settings.Secret); err != nil {
			return err
		}
	}
	if settings.Enabled {
		secret, found, err := s.cloudCredentials.Read()
		if err != nil {
			return err
		}
		if !found || secret == "" {
			return fmt.Errorf("cloud shared secret is required")
		}
	}
	config, err := s.store.GetCloudConfig()
	if err != nil {
		return err
	}
	config.URL = cloudURL
	config.Enabled = settings.Enabled
	return s.store.SaveCloudConfig(config)
}

func (s *Service) CreateBackup() (string, error) {
	data, err := s.store.ExportBackupData()
	if err != nil {
		return "", err
	}
	encodedData, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	checksum := sha256.Sum256(encodedData)
	envelope := BackupEnvelope{
		Version: 1, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Checksum: hex.EncodeToString(checksum[:]), Data: data,
	}
	encoded, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func (s *Service) RestoreBackup(content string) error {
	var envelope BackupEnvelope
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return fmt.Errorf("decode backup: %w", err)
	}
	if envelope.Version != 1 {
		return fmt.Errorf("unsupported backup version %d", envelope.Version)
	}
	encodedData, err := json.Marshal(envelope.Data)
	if err != nil {
		return err
	}
	checksum := sha256.Sum256(encodedData)
	if !strings.EqualFold(envelope.Checksum, hex.EncodeToString(checksum[:])) {
		return fmt.Errorf("backup checksum does not match")
	}
	if err := s.store.RestoreBackupData(envelope.Data); err != nil {
		return fmt.Errorf("restore backup: %w", err)
	}
	return nil
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

func (s *Service) ensureDeviceID() error {
	config, err := s.store.GetCloudConfig()
	if err != nil {
		return err
	}
	if config.DeviceID != "" {
		return nil
	}
	identifier := make([]byte, 16)
	if _, err := rand.Read(identifier); err != nil {
		return fmt.Errorf("generate installation id: %w", err)
	}
	config.DeviceID = hex.EncodeToString(identifier)
	return s.store.SaveCloudConfig(config)
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

func subscriptionKey(provider, accountKey string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.TrimSpace(accountKey)
}

func floatPointer(value float64) *float64 {
	return &value
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
