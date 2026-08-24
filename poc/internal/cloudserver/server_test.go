package cloudserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"token-monitor-analytics/internal/analytics"
	"token-monitor-analytics/internal/storage"
)

func TestSyncAndDashboard(t *testing.T) {
	server, err := New(filepath.Join(t.TempDir(), "cloud.db"), "secret")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	payload := SyncRequest{
		DeviceID: "device-a",
		Snapshots: []storage.SyncSnapshot{{
			LocalID: 1, FetchedAt: "2026-08-23T00:00:00Z",
			RawJSON:      json.RawMessage(`{"periods":{"month":{"totalTokens":100,"costUsd":2,"clients":{"codex":100},"clientCosts":{"codex":2}}},"limits":{"providers":[{"provider":"codex","accountKey":"account"}]}}`),
			Observations: []analytics.Observation{{Provider: "codex", AccountKey: "account", WindowKind: "weekly", ObservedAt: "2026-08-23T00:00:00Z"}},
		}},
		Subscriptions: []storage.Subscription{{Provider: "codex", AccountKey: "account", AccountLabel: "Account", PlanName: "Plus", MonthlyPriceUSD: 20, UpdatedAt: "2026-08-23T00:00:00Z"}},
	}
	encoded, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sync", bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("sync status=%d body=%s", response.Code, response.Body.String())
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/dashboard", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("dashboard status=%d body=%s", response.Code, response.Body.String())
	}
	var dashboard Dashboard
	if err := json.Unmarshal(response.Body.Bytes(), &dashboard); err != nil {
		t.Fatal(err)
	}
	if dashboard.DeviceCount != 1 || dashboard.Analysis.TotalCostUSD != 2 || len(dashboard.Observations) != 1 || len(dashboard.Subscriptions) != 1 {
		t.Fatalf("dashboard=%+v", dashboard)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/dashboard", nil)
	response = httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", response.Code)
	}
}
