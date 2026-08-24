package cloudserver

import (
	"crypto/subtle"
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"

	_ "modernc.org/sqlite"
	"token-monitor-analytics/internal/analytics"
	"token-monitor-analytics/internal/storage"
)

const maxSyncBodySize = 32 << 20

//go:embed web/*
var webAssets embed.FS

type Server struct {
	db     *sql.DB
	secret string
	mux    *http.ServeMux
}

type SyncRequest struct {
	DeviceID      string                 `json:"deviceId"`
	Snapshots     []storage.SyncSnapshot `json:"snapshots"`
	Subscriptions []storage.Subscription `json:"subscriptions"`
}

type Dashboard struct {
	GeneratedAt   string                  `json:"generatedAt"`
	DeviceCount   int                     `json:"deviceCount"`
	Analysis      analytics.StatsAnalysis `json:"analysis"`
	Observations  []analytics.Observation `json:"observations"`
	Subscriptions []storage.Subscription  `json:"subscriptions"`
}

func New(databasePath, secret string) (*Server, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, fmt.Errorf("cloud shared secret is required")
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, err
	}
	server := &Server{db: database, secret: secret, mux: http.NewServeMux()}
	if err := server.initialize(); err != nil {
		_ = database.Close()
		return nil, err
	}
	server.routes()
	return server, nil
}

func (s *Server) Close() error {
	return s.db.Close()
}

func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) initialize() error {
	_, err := s.db.Exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS cloud_snapshots (
  device_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_json BLOB NOT NULL,
  PRIMARY KEY(device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_snapshots_time ON cloud_snapshots(fetched_at DESC);
CREATE TABLE IF NOT EXISTS cloud_observations (
  device_id TEXT NOT NULL,
  local_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY(device_id, local_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_cloud_observations_time ON cloud_observations(observed_at DESC);
CREATE TABLE IF NOT EXISTS cloud_subscriptions (
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  PRIMARY KEY(device_id, provider, account_key)
);
`)
	return err
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /api/health", func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "role": "token-monitor-analytics-cloud", "now": time.Now().UTC()})
	})
	s.mux.Handle("POST /api/v1/sync", s.authorize(http.HandlerFunc(s.handleSync)))
	s.mux.Handle("GET /api/v1/dashboard", s.authorize(http.HandlerFunc(s.handleDashboard)))
	content, _ := fs.Sub(webAssets, "web")
	s.mux.Handle("/", http.FileServer(http.FS(content)))
}

func (s *Server) authorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if len(provided) != len(s.secret) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.secret)) != 1 {
			writeJSON(writer, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (s *Server) handleSync(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, maxSyncBodySize)
	decoder := json.NewDecoder(request.Body)
	var payload SyncRequest
	if err := decoder.Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid sync payload"})
		return
	}
	if strings.TrimSpace(payload.DeviceID) == "" || len(payload.DeviceID) > 128 {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid device id"})
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "database unavailable"})
		return
	}
	rollback := func() { _ = tx.Rollback() }
	acceptedThrough := int64(0)
	for _, snapshot := range payload.Snapshots {
		if snapshot.LocalID <= 0 || !json.Valid(snapshot.RawJSON) {
			rollback()
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid snapshot"})
			return
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO cloud_snapshots(device_id, local_id, fetched_at, raw_json)
VALUES(?, ?, ?, ?)`, payload.DeviceID, snapshot.LocalID, snapshot.FetchedAt, snapshot.RawJSON); err != nil {
			rollback()
			writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "save snapshot failed"})
			return
		}
		for index, observation := range snapshot.Observations {
			encoded, err := json.Marshal(observation)
			if err != nil {
				rollback()
				writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid observation"})
				return
			}
			if _, err := tx.Exec(`INSERT OR REPLACE INTO cloud_observations(device_id, local_id, sequence, observed_at, observation_json)
VALUES(?, ?, ?, ?, ?)`, payload.DeviceID, snapshot.LocalID, index, observation.ObservedAt, encoded); err != nil {
				rollback()
				writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "save observation failed"})
				return
			}
		}
		if snapshot.LocalID > acceptedThrough {
			acceptedThrough = snapshot.LocalID
		}
	}
	if _, err := tx.Exec("DELETE FROM cloud_subscriptions WHERE device_id = ?", payload.DeviceID); err != nil {
		rollback()
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "save subscriptions failed"})
		return
	}
	for _, subscription := range payload.Subscriptions {
		encoded, err := json.Marshal(subscription)
		if err != nil {
			rollback()
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "invalid subscription"})
			return
		}
		if _, err := tx.Exec(`INSERT INTO cloud_subscriptions(device_id, provider, account_key, updated_at, subscription_json)
VALUES(?, ?, ?, ?, ?)`, payload.DeviceID, subscription.Provider, subscription.AccountKey, subscription.UpdatedAt, encoded); err != nil {
			rollback()
			writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "save subscriptions failed"})
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "commit failed"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"acceptedThrough": acceptedThrough})
}

func (s *Server) handleDashboard(writer http.ResponseWriter, _ *http.Request) {
	dashboard, err := s.dashboard()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "build dashboard failed"})
		return
	}
	writeJSON(writer, http.StatusOK, dashboard)
}

func (s *Server) dashboard() (Dashboard, error) {
	dashboard := Dashboard{GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := s.db.QueryRow("SELECT COUNT(DISTINCT device_id) FROM cloud_snapshots").Scan(&dashboard.DeviceCount); err != nil {
		return dashboard, err
	}
	var raw []byte
	err := s.db.QueryRow("SELECT raw_json FROM cloud_snapshots ORDER BY fetched_at DESC LIMIT 1").Scan(&raw)
	if err != nil && err != sql.ErrNoRows {
		return dashboard, err
	}
	if len(raw) > 0 {
		dashboard.Analysis, err = analytics.AnalyzeStats(raw, "month")
		if err != nil {
			return dashboard, err
		}
	}
	rows, err := s.db.Query("SELECT observation_json FROM cloud_observations ORDER BY observed_at DESC LIMIT 500")
	if err != nil {
		return dashboard, err
	}
	for rows.Next() {
		var encoded []byte
		var observation analytics.Observation
		if err := rows.Scan(&encoded); err != nil {
			rows.Close()
			return dashboard, err
		}
		if err := json.Unmarshal(encoded, &observation); err != nil {
			rows.Close()
			return dashboard, err
		}
		dashboard.Observations = append(dashboard.Observations, observation)
	}
	if err := rows.Close(); err != nil {
		return dashboard, err
	}
	subscriptionRows, err := s.db.Query("SELECT subscription_json FROM cloud_subscriptions ORDER BY updated_at DESC")
	if err != nil {
		return dashboard, err
	}
	seen := make(map[string]struct{})
	for subscriptionRows.Next() {
		var encoded []byte
		var subscription storage.Subscription
		if err := subscriptionRows.Scan(&encoded); err != nil {
			subscriptionRows.Close()
			return dashboard, err
		}
		if err := json.Unmarshal(encoded, &subscription); err != nil {
			subscriptionRows.Close()
			return dashboard, err
		}
		key := strings.ToLower(subscription.Provider) + "\x00" + subscription.AccountKey
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		dashboard.Subscriptions = append(dashboard.Subscriptions, subscription)
	}
	return dashboard, subscriptionRows.Close()
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
