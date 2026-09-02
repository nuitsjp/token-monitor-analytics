package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestMigration17SimplifiesStatusAndRecomputesStaleEstimations(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "migration17.sqlite3")

	// 1. Open Lifecycle so that migrations run and schema is ready
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(ctx, dbPath); err != nil {
		t.Fatalf("initial lifecycle open: %v", err)
	}
	db, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}

	defer func() {
		_ = lifecycle.Close()
	}()

	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)

	// Set up base entities
	mustExec(t, db, `INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('s1', 'p1', 'Service 1', 's1.official', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('def1', 's1', 'weekly', 'tokens', 'percent', 'not_applicable', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('acc1', 's1', 'Account 1', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES ('plan1', 's1', 'Plan 1', 1, ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, official_source_url, created_at) VALUES ('pv1', 'plan1', 'PV 1', ?, 'https://example.com', ?)`, utcText(now.Add(-24*time.Hour)), utcText(now))
	mustExec(t, db, `INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, created_at, updated_at) VALUES ('ph1', 'acc1', 'pv1', ?, ?, ?)`, utcText(now.Add(-24*time.Hour)), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('hub1', 'Hub 1', 'http://127.0.0.1:8000', 1, 300, ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cs1', 'hub1', 'dev1', 'cost.raw', ?)`, utcText(now))
	mustExec(t, db, `INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('ls1', 'hub1', 'dev1', 'acc1', 'limit.raw', 'weekly', 'weekly', 'percent', 'Tokens', ?)`, utcText(now))
	mustExec(t, db, `INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at) VALUES ('link1', 'ls1', 'acc1', 'def1', ?, ?, ?)`, utcText(now.Add(-24*time.Hour)), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, created_at, updated_at) VALUES ('clink1', 'cs1', 'acc1', ?, ?, ?)`, utcText(now.Add(-24*time.Hour)), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('int1', 's1', 'acc1', 'ls1', 'def1', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, utcText(now.Add(-time.Hour)), utcText(now.Add(time.Hour)), utcText(now), utcText(now))

	// Insert estimation points
	mustExec(t, db, `INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at) VALUES ('pt1', 's1', 'def1', 'weekly', 'int1', '["int1"]', ?, 10, '[0.1]', '["ls1"]', '["acc1"]', '["pv1"]', '["int1"]', '["cs1"]', '["link1"]', '[]', 'match-v1', ?, ?, ?)`, utcText(now.Add(-30*time.Minute)), domain.CalculationLogicVersion, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('m-cost-1', 'pt1', 'cost', 'cs1', 'acc1', 'obs-cost-1', ?, 0, 100, 300, 0, NULL, 1, 'rule', 'logic')`, utcText(now.Add(-30*time.Minute)))
	mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('m-limit-1', 'pt1', 'limit', 'ls1', 'acc1', 'obs-limit-1', ?, 0, 100, 300, 0, 1000, 1, 'rule', 'logic')`, utcText(now.Add(-30*time.Minute)))

	mustExec(t, db, `INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at) VALUES ('pt2', 's1', 'def1', 'weekly', 'int1', '["int1"]', ?, 30, '[0.3]', '["ls1"]', '["acc1"]', '["pv1"]', '["int1"]', '["cs1"]', '["link1"]', '[]', 'match-v1', ?, ?, ?)`, utcText(now.Add(-10*time.Minute)), domain.CalculationLogicVersion, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('m-cost-2', 'pt2', 'cost', 'cs1', 'acc1', 'obs-cost-2', ?, 0, 100, 300, 0, NULL, 1, 'rule', 'logic')`, utcText(now.Add(-10*time.Minute)))
	mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('m-limit-2', 'pt2', 'limit', 'ls1', 'acc1', 'obs-limit-2', ?, 0, 100, 300, 0, 1000, 1, 'rule', 'logic')`, utcText(now.Add(-10*time.Minute)))

	// Insert audit record
	mustExec(t, db, `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id) VALUES ('audit1', ?, 'system', 'test', 'service', 's1')`, utcText(now))

	// Count immutable inputs before reopening
	costObsCount := mustCount(t, db, `SELECT count(*) FROM usage_cost_observations`)
	limitObsCount := mustCount(t, db, `SELECT count(*) FROM usage_limit_observations`)
	linkCount := mustCount(t, db, `SELECT count(*) FROM usage_limit_source_links`)
	phCount := mustCount(t, db, `SELECT count(*) FROM plan_histories`)
	auditCount := mustCount(t, db, `SELECT count(*) FROM configuration_audits`)

	// Close lifecycle
	if err := lifecycle.Close(); err != nil {
		t.Fatal(err)
	}

	// 2. Reopen lifecycle. Reopen automatically executes RecalculateStaleDerivedResults.
	reopened := &Lifecycle{}
	if err := reopened.Open(ctx, dbPath); err != nil {
		t.Fatalf("reopened lifecycle: %v", err)
	}
	defer func() {
		_ = reopened.Close()
	}()

	reopenedDB, err := reopened.DB()
	if err != nil {
		t.Fatal(err)
	}

	// Verify that the estimation result was recomputed with new CalculationLogicVersion and estimated status
	var status, logicVersion, reasonsJSON string
	var obsCount int
	err = reopenedDB.QueryRowContext(ctx, `
		SELECT status, calculation_logic_version, observation_point_count, reasons_json
		FROM estimation_results
		WHERE calculation_interval_ids_json LIKE '%"int1"%'
	`).Scan(&status, &logicVersion, &obsCount, &reasonsJSON)
	if err != nil {
		t.Fatalf("query recomputed estimation result: %v", err)
	}
	if status != "estimated" {
		t.Fatalf("recomputed status = %s (reasons = %s), want estimated", status, reasonsJSON)
	}
	if logicVersion != domain.CalculationLogicVersion {
		t.Fatalf("recomputed logic version = %s, want %s", logicVersion, domain.CalculationLogicVersion)
	}
	if obsCount != 2 {
		t.Fatalf("observation point count = %d, want 2", obsCount)
	}

	// 3. Verify that immutable source facts are completely unchanged
	costObsCountAfter := mustCount(t, reopenedDB, `SELECT count(*) FROM usage_cost_observations`)
	limitObsCountAfter := mustCount(t, reopenedDB, `SELECT count(*) FROM usage_limit_observations`)
	linkCountAfter := mustCount(t, reopenedDB, `SELECT count(*) FROM usage_limit_source_links`)
	phCountAfter := mustCount(t, reopenedDB, `SELECT count(*) FROM plan_histories`)
	auditCountAfter := mustCount(t, reopenedDB, `SELECT count(*) FROM configuration_audits`)

	if costObsCountAfter != costObsCount || limitObsCountAfter != limitObsCount ||
		linkCountAfter != linkCount || phCountAfter != phCount || auditCountAfter != auditCount {
		t.Fatalf("immutable source facts were modified: costObs=%d/%d limitObs=%d/%d links=%d/%d ph=%d/%d audit=%d/%d",
			costObsCountAfter, costObsCount, limitObsCountAfter, limitObsCount, linkCountAfter, linkCount, phCountAfter, phCount, auditCountAfter, auditCount)
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func mustCount(t *testing.T, db *sql.DB, query string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), query).Scan(&count); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return count
}
