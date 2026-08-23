package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"token-monitor-analytics/internal/storage"
)

const cloudSyncBatchSize = 5

type cloudSyncRequest struct {
	DeviceID      string                 `json:"deviceId"`
	Snapshots     []storage.SyncSnapshot `json:"snapshots"`
	Subscriptions []storage.Subscription `json:"subscriptions"`
}

type cloudSyncResponse struct {
	AcceptedThrough int64 `json:"acceptedThrough"`
}

func (s *Service) SyncCloudNow() (CloudSyncResult, error) {
	config, err := s.store.GetCloudConfig()
	if err != nil {
		return CloudSyncResult{}, err
	}
	if !config.Enabled {
		return CloudSyncResult{}, fmt.Errorf("cloud sync is disabled")
	}
	if config.URL == "" || config.DeviceID == "" {
		return CloudSyncResult{}, fmt.Errorf("cloud sync is not configured")
	}
	secret, found, err := s.cloudCredentials.Read()
	if err != nil {
		return CloudSyncResult{}, err
	}
	if !found || secret == "" {
		return CloudSyncResult{}, fmt.Errorf("cloud shared secret is not configured")
	}
	subscriptions, err := s.store.Subscriptions()
	if err != nil {
		return CloudSyncResult{}, err
	}
	result := CloudSyncResult{AcceptedThrough: config.SyncCursor}
	for {
		snapshots, err := s.store.SnapshotsAfter(result.AcceptedThrough, cloudSyncBatchSize)
		if err != nil {
			return CloudSyncResult{}, err
		}
		acceptedThrough, err := s.pushCloudBatch(config.URL, secret, cloudSyncRequest{
			DeviceID: config.DeviceID, Snapshots: snapshots, Subscriptions: subscriptions,
		})
		if err != nil {
			s.setError(err)
			return CloudSyncResult{}, err
		}
		if len(snapshots) > 0 {
			lastLocalID := snapshots[len(snapshots)-1].LocalID
			if acceptedThrough < lastLocalID {
				return CloudSyncResult{}, fmt.Errorf("cloud accepted cursor %d before uploaded snapshot %d", acceptedThrough, lastLocalID)
			}
			result.UploadedSnapshots += len(snapshots)
			result.AcceptedThrough = acceptedThrough
			if err := s.store.SetCloudSyncCursor(acceptedThrough); err != nil {
				return CloudSyncResult{}, err
			}
		}
		if len(snapshots) < cloudSyncBatchSize {
			break
		}
	}
	result.SyncedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return result, nil
}

func (s *Service) pushCloudBatch(cloudURL, secret string, payload cloudSyncRequest) (int64, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cloudURL, "/")+"/api/v1/sync", bytes.NewReader(encoded))
	if err != nil {
		return 0, err
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("cloud sync request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return 0, fmt.Errorf("cloud sync returned %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	var result cloudSyncResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return 0, fmt.Errorf("decode cloud sync response: %w", err)
	}
	return result.AcceptedThrough, nil
}
