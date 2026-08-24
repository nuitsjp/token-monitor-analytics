package storage

import (
	"database/sql"
	"encoding/json"
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

type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

type Subscription struct {
	ID              int64   `json:"id"`
	Provider        string  `json:"provider"`
	AccountKey      string  `json:"accountKey"`
	AccountLabel    string  `json:"accountLabel"`
	PlanName        string  `json:"planName"`
	MonthlyPriceUSD float64 `json:"monthlyPriceUsd"`
	UpdatedAt       string  `json:"updatedAt"`
}

type AccountOption struct {
	Provider     string `json:"provider"`
	AccountKey   string `json:"accountKey"`
	AccountLabel string `json:"accountLabel"`
}

type CloudConfig struct {
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled"`
	DeviceID   string `json:"deviceId"`
	SyncCursor int64  `json:"syncCursor"`
}

type SyncSnapshot struct {
	LocalID      int64                   `json:"localId"`
	FetchedAt    string                  `json:"fetchedAt"`
	RawJSON      json.RawMessage         `json:"rawJson"`
	Observations []analytics.Observation `json:"observations"`
}

type BackupData struct {
	Settings      map[string]string `json:"settings"`
	Snapshots     []SyncSnapshot    `json:"snapshots"`
	Subscriptions []Subscription    `json:"subscriptions"`
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
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_label TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  monthly_price_usd REAL NOT NULL CHECK(monthly_price_usd > 0),
  updated_at TEXT NOT NULL,
  UNIQUE(provider, account_key)
);
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

func (s *Store) SaveSubscription(subscription Subscription) (Subscription, error) {
	subscription.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	err := s.db.QueryRow(`INSERT INTO subscriptions(
provider, account_key, account_label, plan_name, monthly_price_usd, updated_at
) VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(provider, account_key) DO UPDATE SET
  account_label = excluded.account_label,
  plan_name = excluded.plan_name,
  monthly_price_usd = excluded.monthly_price_usd,
  updated_at = excluded.updated_at
RETURNING id`, subscription.Provider, subscription.AccountKey, subscription.AccountLabel,
		subscription.PlanName, subscription.MonthlyPriceUSD, subscription.UpdatedAt).Scan(&subscription.ID)
	if err != nil {
		return Subscription{}, fmt.Errorf("save subscription: %w", err)
	}
	return subscription, nil
}

func (s *Store) DeleteSubscription(id int64) error {
	result, err := s.db.Exec("DELETE FROM subscriptions WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("delete subscription: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if deleted == 0 {
		return fmt.Errorf("subscription %d not found", id)
	}
	return nil
}

func (s *Store) Subscriptions() ([]Subscription, error) {
	return subscriptionsFrom(s.db)
}

func subscriptionsFrom(source queryer) ([]Subscription, error) {
	rows, err := source.Query(`SELECT id, provider, account_key, account_label, plan_name,
monthly_price_usd, updated_at FROM subscriptions ORDER BY provider, account_label`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subscriptions []Subscription
	for rows.Next() {
		var subscription Subscription
		if err := rows.Scan(&subscription.ID, &subscription.Provider, &subscription.AccountKey,
			&subscription.AccountLabel, &subscription.PlanName, &subscription.MonthlyPriceUSD,
			&subscription.UpdatedAt); err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

func (s *Store) Accounts() ([]AccountOption, error) {
	rows, err := s.db.Query(`SELECT provider, account_key, MAX(account_label)
FROM observations WHERE account_key <> '' GROUP BY provider, account_key ORDER BY provider, account_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var accounts []AccountOption
	for rows.Next() {
		var account AccountOption
		if err := rows.Scan(&account.Provider, &account.AccountKey, &account.AccountLabel); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

func (s *Store) LatestSnapshotRaw() ([]byte, error) {
	var raw []byte
	err := s.db.QueryRow("SELECT raw_json FROM snapshots ORDER BY fetched_at DESC, id DESC LIMIT 1").Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return raw, err
}

func (s *Store) AllHistory() ([]analytics.Observation, error) {
	rows, err := s.db.Query(`SELECT provider, account_key, account_label, window_kind, window_label,
period_key, period_start, period_end, reset_at, usage_usd, utilization_percent,
estimated_limit_usd, calculation_status, calculation_note, observed_at, calculated_at
FROM observations ORDER BY observed_at, id`)
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

func (s *Store) GetCloudConfig() (CloudConfig, error) {
	config := CloudConfig{}
	rows, err := s.db.Query("SELECT key, value FROM settings WHERE key IN ('cloud_url', 'cloud_enabled', 'installation_id', 'cloud_sync_cursor')")
	if err != nil {
		return config, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return config, err
		}
		switch key {
		case "cloud_url":
			config.URL = value
		case "cloud_enabled":
			config.Enabled = value == "true"
		case "installation_id":
			config.DeviceID = value
		case "cloud_sync_cursor":
			config.SyncCursor, _ = strconv.ParseInt(value, 10, 64)
		}
	}
	return config, rows.Err()
}

func (s *Store) SaveCloudConfig(config CloudConfig) error {
	values := map[string]string{
		"cloud_url":         config.URL,
		"cloud_enabled":     strconv.FormatBool(config.Enabled),
		"installation_id":   config.DeviceID,
		"cloud_sync_cursor": strconv.FormatInt(config.SyncCursor, 10),
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	for key, value := range values {
		if _, err := tx.Exec(`INSERT INTO settings(key, value) VALUES(?, ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) SetCloudSyncCursor(cursor int64) error {
	_, err := s.db.Exec(`INSERT INTO settings(key, value) VALUES('cloud_sync_cursor', ?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value`, strconv.FormatInt(cursor, 10))
	return err
}

func (s *Store) SnapshotsAfter(cursor int64, limit int) ([]SyncSnapshot, error) {
	return snapshotsAfter(s.db, cursor, limit)
}

func snapshotsAfter(source queryer, cursor int64, limit int) ([]SyncSnapshot, error) {
	query := "SELECT id, fetched_at, raw_json FROM snapshots WHERE id > ? ORDER BY id"
	args := []any{cursor}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := source.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var snapshots []SyncSnapshot
	for rows.Next() {
		var snapshot SyncSnapshot
		if err := rows.Scan(&snapshot.LocalID, &snapshot.FetchedAt, &snapshot.RawJSON); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range snapshots {
		observations, err := observationsForSnapshot(source, snapshots[index].LocalID)
		if err != nil {
			return nil, err
		}
		snapshots[index].Observations = observations
	}
	return snapshots, nil
}

func (s *Store) ExportBackupData() (BackupData, error) {
	backup := BackupData{Settings: make(map[string]string)}
	tx, err := s.db.Begin()
	if err != nil {
		return backup, err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT key, value FROM settings WHERE key <> 'secret'")
	if err != nil {
		return backup, err
	}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			rows.Close()
			return backup, err
		}
		backup.Settings[key] = value
	}
	if err := rows.Close(); err != nil {
		return backup, err
	}
	backup.Snapshots, err = snapshotsAfter(tx, 0, 0)
	if err != nil {
		return backup, err
	}
	backup.Subscriptions, err = subscriptionsFrom(tx)
	if err != nil {
		return backup, err
	}
	return backup, tx.Commit()
}

func (s *Store) RestoreBackupData(backup BackupData) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	rollback := func(cause error) error {
		_ = tx.Rollback()
		return cause
	}
	if _, err := tx.Exec("DELETE FROM observations; DELETE FROM snapshots; DELETE FROM subscriptions; DELETE FROM settings"); err != nil {
		return rollback(err)
	}
	for key, value := range backup.Settings {
		if key == "secret" {
			continue
		}
		if key == "cloud_sync_cursor" {
			value = "0"
		}
		if _, err := tx.Exec("INSERT INTO settings(key, value) VALUES(?, ?)", key, value); err != nil {
			return rollback(err)
		}
	}
	if _, exists := backup.Settings["cloud_sync_cursor"]; !exists {
		if _, err := tx.Exec("INSERT INTO settings(key, value) VALUES('cloud_sync_cursor', '0')"); err != nil {
			return rollback(err)
		}
	}
	for _, snapshot := range backup.Snapshots {
		if !json.Valid(snapshot.RawJSON) {
			return rollback(fmt.Errorf("snapshot %d contains invalid JSON", snapshot.LocalID))
		}
		if _, err := tx.Exec(`INSERT INTO snapshots(id, fetched_at, observed_at, endpoint, raw_json)
VALUES(?, ?, ?, 'restored-backup', ?)`, snapshot.LocalID, snapshot.FetchedAt, snapshot.FetchedAt, snapshot.RawJSON); err != nil {
			return rollback(err)
		}
		for _, observation := range snapshot.Observations {
			if err := insertObservation(tx, snapshot.LocalID, observation); err != nil {
				return rollback(err)
			}
		}
	}
	for _, subscription := range backup.Subscriptions {
		if subscription.MonthlyPriceUSD <= 0 {
			return rollback(fmt.Errorf("subscription %d has an invalid monthly price", subscription.ID))
		}
		if _, err := tx.Exec(`INSERT INTO subscriptions(id, provider, account_key, account_label, plan_name, monthly_price_usd, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?)`, subscription.ID, subscription.Provider, subscription.AccountKey,
			subscription.AccountLabel, subscription.PlanName, subscription.MonthlyPriceUSD, subscription.UpdatedAt); err != nil {
			return rollback(err)
		}
	}
	return tx.Commit()
}

func observationsForSnapshot(source queryer, snapshotID int64) ([]analytics.Observation, error) {
	rows, err := source.Query(`SELECT provider, account_key, account_label, window_kind, window_label,
period_key, period_start, period_end, reset_at, usage_usd, utilization_percent,
estimated_limit_usd, calculation_status, calculation_note, observed_at, calculated_at
FROM observations WHERE snapshot_id = ? ORDER BY id`, snapshotID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var observations []analytics.Observation
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
		observations = append(observations, observation)
	}
	return observations, rows.Err()
}

func insertObservation(tx *sql.Tx, snapshotID int64, observation analytics.Observation) error {
	_, err := tx.Exec(`INSERT INTO observations(
snapshot_id, provider, account_key, account_label, window_kind, window_label,
period_key, period_start, period_end, reset_at, usage_usd, utilization_percent,
estimated_limit_usd, calculation_status, calculation_note, observed_at, calculated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, snapshotID,
		observation.Provider, observation.AccountKey, observation.AccountLabel, observation.WindowKind,
		observation.WindowLabel, observation.PeriodKey, observation.PeriodStart, observation.PeriodEnd,
		observation.ResetAt, observation.UsageUSD, observation.UtilizationPercent,
		observation.EstimatedLimitUSD, observation.CalculationStatus, observation.CalculationNote,
		observation.ObservedAt, observation.CalculatedAt)
	return err
}
