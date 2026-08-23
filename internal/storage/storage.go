package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
	"token-monitor-analytics/internal/analytics"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("database path is empty")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	store := &Store{db: db}
	if err := store.initialize(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) initialize() error {
	const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  raw_json BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_label TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_label TEXT NOT NULL,
  period_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  reset_at TEXT NOT NULL,
  usage_usd REAL NOT NULL,
  utilization_percent REAL NOT NULL,
  estimated_limit_usd REAL NOT NULL,
  calculation_status TEXT NOT NULL,
  calculation_note TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(provider, account_key, window_kind, observed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_fetched_at ON snapshots(fetched_at DESC);
`
	if _, err := s.db.Exec(schema); err != nil {
		return fmt.Errorf("initialize database: %w", err)
	}
	return nil
}

func (s *Store) GetSettings() (hubURL string, intervalSeconds int, err error) {
	rows, err := s.db.Query("SELECT key, value FROM settings WHERE key IN ('hub_url', 'interval_seconds')")
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return "", 0, err
		}
		switch key {
		case "hub_url":
			hubURL = value
		case "interval_seconds":
			intervalSeconds, _ = strconv.Atoi(value)
		}
	}
	if err := rows.Err(); err != nil {
		return "", 0, err
	}
	return hubURL, intervalSeconds, nil
}

func (s *Store) SaveSettings(hubURL string, intervalSeconds int) error {
	values := map[string]string{
		"hub_url":          hubURL,
		"interval_seconds": strconv.Itoa(intervalSeconds),
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for key, value := range values {
		if _, err := tx.Exec(`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("save setting %s: %w", key, err)
		}
	}
	return tx.Commit()
}

func (s *Store) LegacySecret() (string, error) {
	var secret string
	err := s.db.QueryRow("SELECT value FROM settings WHERE key = 'secret'").Scan(&secret)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return secret, err
}

func (s *Store) DeleteLegacySecret() error {
	_, err := s.db.Exec("DELETE FROM settings WHERE key = 'secret'")
	return err
}

func (s *Store) SaveSnapshot(fetchedAt time.Time, endpoint string, raw []byte, observations []analytics.Observation) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	result, err := tx.Exec(`INSERT INTO snapshots(fetched_at, observed_at, endpoint, raw_json) VALUES(?, ?, ?, ?)`, fetchedAt.UTC().Format(time.RFC3339Nano), fetchedAt.UTC().Format(time.RFC3339Nano), endpoint, raw)
	if err != nil {
		_ = tx.Rollback()
		return 0, fmt.Errorf("save raw snapshot: %w", err)
	}
	snapshotID, err := result.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		return 0, err
	}
	for _, observation := range observations {
		_, err = tx.Exec(`INSERT INTO observations(
snapshot_id, provider, account_key, account_label, window_kind, window_label,
period_key, period_start, period_end, reset_at, usage_usd, utilization_percent,
estimated_limit_usd, calculation_status, calculation_note, observed_at, calculated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			snapshotID, observation.Provider, observation.AccountKey, observation.AccountLabel,
			observation.WindowKind, observation.WindowLabel, observation.PeriodKey,
			observation.PeriodStart, observation.PeriodEnd, observation.ResetAt,
			observation.UsageUSD, observation.UtilizationPercent, observation.EstimatedLimitUSD,
			observation.CalculationStatus, observation.CalculationNote, observation.ObservedAt,
			observation.CalculatedAt)
		if err != nil {
			_ = tx.Rollback()
			return 0, fmt.Errorf("save calculated observation: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return snapshotID, nil
}

func (s *Store) History(limit int) ([]analytics.Observation, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT provider, account_key, account_label, window_kind, window_label,
period_key, period_start, period_end, reset_at, usage_usd, utilization_percent,
estimated_limit_usd, calculation_status, calculation_note, observed_at, calculated_at
FROM observations ORDER BY observed_at DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []analytics.Observation
	for rows.Next() {
		var observation analytics.Observation
		if err := rows.Scan(&observation.Provider, &observation.AccountKey, &observation.AccountLabel,
			&observation.WindowKind, &observation.WindowLabel, &observation.PeriodKey,
			&observation.PeriodStart, &observation.PeriodEnd, &observation.ResetAt,
			&observation.UsageUSD, &observation.UtilizationPercent, &observation.EstimatedLimitUSD,
			&observation.CalculationStatus, &observation.CalculationNote, &observation.ObservedAt,
			&observation.CalculatedAt); err != nil {
			return nil, err
		}
		result = append(result, observation)
	}
	return result, rows.Err()
}

func (s *Store) SnapshotCount() (int, error) {
	var count int
	err := s.db.QueryRow("SELECT COUNT(*) FROM snapshots").Scan(&count)
	return count, err
}
