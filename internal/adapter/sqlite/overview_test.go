package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestReadOverviewDataReturnsOnlyRecentIncreaseWithinCurrentEstimableInterval(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	execOverviewSQL(t, database, `INSERT INTO hubs (hub_id, display_name, url, enabled, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('hub-overview', 'Hub overview', 'http://localhost:17321', 1, 1, 300, ?, ?)`, utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO hub_connection_statuses (hub_id, state, checked_at) VALUES ('hub-overview', 'connected', ?)`, utcText(now))
	execOverviewSQL(t, database, `INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, completed_at, analytics_interval_seconds) VALUES ('attempt-overview', 'hub-overview', 'scheduled', 'succeeded', ?, ?, 300)`, utcText(now.Add(-time.Minute)), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds) VALUES ('attempt-running', 'hub-overview', 'manual', 'started', ?, 300)`, utcText(now.Add(time.Minute)))
	execOverviewSQL(t, database, `INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body) VALUES ('snapshot-overview', 'attempt-overview', 'hub-overview', 'stats', ?, ?, 200, ?)`, utcText(now.Add(-time.Minute)), utcText(now), []byte(`{}`))
	execOverviewSQL(t, database, `INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('service-overview', 'Provider', 'Service overview', 'overview.service', ?, ?)`, utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('definition-overview', 'service-overview', 'weekly', 'Weekly input', 'percent', 'not_applicable', ?, ?)`, utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('account-overview', 'service-overview', 'Account overview', ?, ?)`, utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('source-overview', 'hub-overview', 'device-overview', 'account-key', 'provider.overview', 'window-overview', 'window', 'percent', 'Weekly input', ?)`, utcText(now))
	execOverviewSQL(t, database, `INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at) VALUES ('association-overview', 'source-overview', 'account-overview', 'definition-overview', ?, ?, ?)`, utcText(now.Add(-time.Hour)), utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('interval-overview-old', 'service-overview', 'account-overview', 'source-overview', 'definition-overview', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, utcText(now.Add(-30*time.Minute)), utcText(now.Add(-15*time.Minute)), utcText(now), utcText(now))
	execOverviewSQL(t, database, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('interval-overview-current', 'service-overview', 'account-overview', 'source-overview', 'definition-overview', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, utcText(now.Add(-15*time.Minute)), utcText(now.Add(time.Hour)), utcText(now), utcText(now))
	insertOverviewLimitObservation(t, database, "observation-overview-1", now.Add(-20*time.Minute), nil, 20)
	insertOverviewLimitObservation(t, database, "observation-overview-2", now.Add(-10*time.Minute), nil, 25.5)

	beforeSameIntervalIncrease, err := lifecycle.ReadOverviewData(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(beforeSameIntervalIncrease.RecentLimits) != 0 {
		t.Fatalf("increase across calculation interval boundary was displayed: %#v", beforeSameIntervalIncrease.RecentLimits)
	}
	insertOverviewLimitObservation(t, database, "observation-overview-3", now.Add(-5*time.Minute), nil, 30)

	result, err := lifecycle.ReadOverviewData(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Hubs) != 1 || result.Hubs[0].DisplayName != "Hub overview" || !result.Hubs[0].CollectionRunning || result.Hubs[0].LastCollectionState != "succeeded" || result.Hubs[0].LastSuccessAt == nil {
		t.Fatalf("overview Hubs = %#v", result.Hubs)
	}
	if result.RawSnapshotCount != 1 || result.DatabaseSizeBytes <= 0 {
		t.Fatalf("overview capacity = count %d, size %d", result.RawSnapshotCount, result.DatabaseSizeBytes)
	}
	if len(result.RecentLimits) != 1 {
		t.Fatalf("recent limits = %#v", result.RecentLimits)
	}
	limit := result.RecentLimits[0]
	if limit.UsedPercent != 30 || limit.ResetsAt != nil || !limit.LastIncreaseAt.Equal(now.Add(-5*time.Minute)) || !limit.LatestObservationAt.Equal(now.Add(-5*time.Minute)) || limit.ExpectedInterval != 5*time.Minute {
		t.Fatalf("recent limit = %#v", limit)
	}
	execOverviewSQL(t, database, `UPDATE usage_limit_source_links SET valid_to = ? WHERE usage_limit_association_id = 'association-overview'`, utcText(now.Add(time.Hour)))
	beforeAssociationEnds, err := lifecycle.ReadOverviewData(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(beforeAssociationEnds.RecentLimits) != 1 {
		t.Fatalf("association with a future end was not displayed: %#v", beforeAssociationEnds.RecentLimits)
	}
	execOverviewSQL(t, database, `UPDATE usage_limit_source_links SET valid_to = ? WHERE usage_limit_association_id = 'association-overview'`, utcText(now.Add(-time.Minute)))
	afterAssociationEnded, err := lifecycle.ReadOverviewData(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterAssociationEnded.RecentLimits) != 0 {
		t.Fatalf("ended association was displayed: %#v", afterAssociationEnded.RecentLimits)
	}
}

func execOverviewSQL(t *testing.T, database *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := database.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func insertOverviewLimitObservation(t *testing.T, database *sql.DB, id string, observed time.Time, reset *time.Time, used float64) {
	t.Helper()
	execOverviewSQL(t, database, `INSERT INTO usage_limit_observations (
		observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key,
		provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label,
		plan_label, used_percent, resets_at, sync_upload_interval_ms, limits_refresh_ms,
		analytics_interval_seconds, normalization_generation, normalization_rule_version,
		normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint
	) VALUES (?, 'snapshot-overview', 'hub-overview', 'device-overview', 'provider.overview', 'account-key', ?, 'window-overview', 'window', 'percent', 'Weekly input', 'Plan', ?, ?, 60000, 300000, 60, 1, 'rule', 'logic', '$.limits', 'canonical', ?, ?)`,
		id, utcText(observed), used, optionalTimeText(reset), "dedupe-"+id, "fingerprint-"+id)
}
