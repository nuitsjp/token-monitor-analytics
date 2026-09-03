package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
	"token-monitor-analytics/internal/domain"
)

func TestMigration18RebuildsV17DerivedDataFromSourceFacts(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "migration18.sqlite3")
	if file, err := os.Create(dbPath); err != nil {
		t.Fatalf("create database file: %v", err)
	} else if err := file.Close(); err != nil {
		t.Fatalf("close database file: %v", err)
	}

	db, err := sql.Open("sqlite", sqliteReadWriteDSN(dbPath))
	if err != nil {
		t.Fatalf("open v17 database: %v", err)
	}
	db.SetMaxOpenConns(1)
	migrationMu.Lock()
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("sqlite3"); err != nil {
		migrationMu.Unlock()
		_ = db.Close()
		t.Fatalf("set migration dialect: %v", err)
	}
	if err := goose.UpToContext(ctx, db, "migrations", 17); err != nil {
		migrationMu.Unlock()
		_ = db.Close()
		t.Fatalf("migrate fixture to v17: %v", err)
	}
	migrationMu.Unlock()

	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	start := now.Add(-time.Hour)
	end := now.Add(time.Hour)
	legacyLogic := "legacy-calculation-v1"
	legacyMatching := "legacy-matching-v1"

	// Catalog, source links, complete facts, and plan history are the immutable
	// inputs from which v18 must regenerate points.
	mustExec(t, db, `INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('s1', 'p1', 'Service 1', 's1.official', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('def1', 's1', 'weekly', 'tokens', 'percent', 'not_applicable', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('acc1', 's1', 'Account 1', ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES ('plan1', 's1', 'Plan 1', 1, ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, official_source_url, created_at) VALUES ('pv1', 'plan1', 'PV 1', ?, 'https://example.com', ?)`, utcText(start.Add(-time.Hour)), utcText(now))
	mustExec(t, db, `INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at) VALUES ('ph1', 'acc1', 'pv1', ?, ?, ?, ?)`, catalogPeriodText(start), catalogPeriodText(end), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('hub1', 'Hub 1', 'http://127.0.0.1:8000', 1, 300, ?, ?)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cs1', 'hub1', 'dev1', 'cost.raw', ?)`, utcText(now))
	mustExec(t, db, `INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('ls1', 'hub1', 'dev1', 'acc1', 'limit.raw', 'weekly', 'weekly', 'percent', 'Tokens', ?)`, utcText(now))
	mustExec(t, db, `INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at) VALUES ('link1', 'ls1', 'acc1', 'def1', ?, ?, ?, ?)`, catalogPeriodText(start), catalogPeriodText(end), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at) VALUES ('clink1', 'cs1', 'acc1', ?, ?, ?, ?)`, catalogPeriodText(start), catalogPeriodText(end), utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO usage_cost_source_completeness (completeness_id, usage_cost_source_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at) VALUES ('complete1', 'cs1', ?, ?, 'confirmed', '["acc1"]', '[]', ?, ?)`, catalogPeriodText(start), catalogPeriodText(end), utcText(now), utcText(now))

	// These are the original observations. Their values produce a positive
	// least-squares candidate of 150 after v18 regenerates all three points.
	mustExec(t, db, `INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, completed_at, analytics_interval_seconds) VALUES ('attempt1', 'hub1', 'manual', 'succeeded', ?, ?, 300)`, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, api_contract, body) VALUES ('snapshot1', 'attempt1', 'hub1', 'stats', ?, ?, 200, 'contract-v1', ?)`, utcText(now), utcText(now), []byte("{}"))
	for index, item := range []struct {
		id     string
		at     time.Time
		cost   string
		used   float64
		finger string
	}{
		{id: "obs1", at: start.Add(15 * time.Minute), cost: "0", used: 0, finger: "finger1"},
		{id: "obs2", at: start.Add(45 * time.Minute), cost: "10", used: 10, finger: "finger2"},
		{id: "obs3", at: start.Add(75 * time.Minute), cost: "30", used: 20, finger: "finger3"},
	} {
		mustExec(t, db, `INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, sync_upload_interval_ms, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES (?, 'snapshot1', 'hub1', 'dev1', 'cost.raw', ?, ?, 0, 300, 1, 'normalization-rule-v1', 'normalization-logic-v1', ?, 'canonical', ?, ?)`, item.id+"-cost", utcText(item.at), item.cost, "$.cost["+string(rune('0'+index))+"]", "cost-key-"+item.id, item.finger)
		mustExec(t, db, `INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at, sync_upload_interval_ms, limits_refresh_ms, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES (?, 'snapshot1', 'hub1', 'dev1', 'limit.raw', 'acc1', ?, 'weekly', 'weekly', 'percent', 'Tokens', 'PV 1', ?, ?, 0, 1000, 300, 1, 'normalization-rule-v1', 'normalization-logic-v1', ?, 'canonical', ?, ?)`, item.id+"-limit", utcText(item.at), item.used, utcText(end), "$.limits["+string(rune('0'+index))+"]", "limit-key-"+item.id, "limit-"+item.finger)
	}

	mustExec(t, db, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('int-estimable', 's1', 'acc1', 'ls1', 'def1', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, catalogPeriodText(start), catalogPeriodText(end), utcText(now), utcText(now))
	intExcludedStart := end.Add(time.Hour)
	intExcludedEnd := end.Add(2 * time.Hour)
	mustExec(t, db, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('int-excluded', 's1', 'acc1', 'ls1', 'def1', 'weekly', ?, ?, 'excluded', 'unsupported_cycle', '[]', ?, ?)`, catalogPeriodText(intExcludedStart), catalogPeriodText(intExcludedEnd), utcText(now), utcText(now))
	intInsufficientStart := intExcludedEnd
	intInsufficientEnd := intInsufficientStart.Add(time.Hour)
	mustExec(t, db, `INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('int-insufficient', 's1', 'acc1', 'ls1', 'def1', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, catalogPeriodText(intInsufficientStart), catalogPeriodText(intInsufficientEnd), utcText(now), utcText(now))

	// v17 derived data: only two legacy points, a result with the old logic,
	// and a residual reason that v18 must not preserve as model_mismatch.
	for index, item := range []struct {
		id    string
		at    time.Time
		cost  string
		used  string
		obsID string
	}{
		{id: "legacy-point-1", at: start.Add(15 * time.Minute), cost: "0", used: "0", obsID: "obs1"},
		{id: "legacy-point-2", at: start.Add(75 * time.Minute), cost: "30", used: "0.2", obsID: "obs3"},
	} {
		mustExec(t, db, `INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, plan_version_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at) VALUES (?, 's1', 'def1', 'pv1', 'weekly', 'int-estimable', '["int-estimable"]', ?, ?, ?, '["ls1"]', '["acc1"]', '["pv1"]', '["int-estimable"]', '["cs1"]', '["link1"]', '["complete1"]', ?, ?, ?, ?)`, item.id, utcText(item.at), item.cost, "["+item.used+"]", legacyMatching, legacyLogic, utcText(now), utcText(now))
		mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES (?, ?, 'cost', 'cs1', 'acc1', ?, ?, 0, 1000000000, 300, 0, NULL, 1, 'normalization-rule-v1', 'normalization-logic-v1')`, "legacy-match-cost-"+string(rune('1'+index)), item.id, item.obsID+"-cost", utcText(item.at))
		mustExec(t, db, `INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES (?, ?, 'limit', 'ls1', 'acc1', ?, ?, 0, 1000000000, 300, 0, 1000, 1, 'normalization-rule-v1', 'normalization-logic-v1')`, "legacy-match-limit-"+string(rune('1'+index)), item.id, item.obsID+"-limit", utcText(item.at))
	}
	legacyResultKey := "legacy-result-estimable"
	mustExec(t, db, `INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at) VALUES ('legacy-result-estimable', ?, 's1', 'def1', 'weekly', '["int-estimable"]', ?, ?, 'model_mismatch', '["residual_over_ten_percent"]', '[150]', 2, 1, 1, 0.2, 0, ?, ?, 'legacy-fingerprint-estimable', ?, ?)`, legacyResultKey, utcText(start), utcText(end), legacyLogic, legacyMatching, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at) VALUES ('legacy-result-excluded', 'legacy-result-excluded-key', 's1', 'def1', 'weekly', '["int-excluded"]', ?, ?, 'uncomputed', '["legacy"]', '[]', 0, 0, 0, 0, 0, ?, ?, 'legacy-fingerprint-excluded', ?, ?)`, utcText(intExcludedStart), utcText(intExcludedEnd), legacyLogic, legacyMatching, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at) VALUES ('legacy-result-insufficient', 'legacy-result-insufficient-key', 's1', 'def1', 'weekly', '["int-insufficient"]', ?, ?, 'uncomputed', '["legacy"]', '[]', 0, 0, 0, 0, 0, ?, ?, 'legacy-fingerprint-insufficient', ?, ?)`, utcText(intInsufficientStart), utcText(intInsufficientEnd), legacyLogic, legacyMatching, utcText(now), utcText(now))
	mustExec(t, db, `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id) VALUES ('audit1', ?, 'system', 'test', 'service', 's1')`, utcText(now))

	immutableCounts := map[string]int{
		"cost observations":  mustCount(t, db, `SELECT count(*) FROM usage_cost_observations`),
		"limit observations": mustCount(t, db, `SELECT count(*) FROM usage_limit_observations`),
		"limit links":        mustCount(t, db, `SELECT count(*) FROM usage_limit_source_links`),
		"cost links":         mustCount(t, db, `SELECT count(*) FROM usage_cost_source_account_links`),
		"plan histories":     mustCount(t, db, `SELECT count(*) FROM plan_histories`),
		"audits":             mustCount(t, db, `SELECT count(*) FROM configuration_audits`),
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close v17 database: %v", err)
	}

	reopened := &Lifecycle{}
	if err := reopened.Open(ctx, dbPath); err != nil {
		t.Fatalf("open v17 database through v18: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	reopenedDB, err := reopened.DB()
	if err != nil {
		t.Fatal(err)
	}
	var status, logicVersion, reasonsJSON, limitsJSON string
	var obsCount int
	err = reopenedDB.QueryRowContext(ctx, `SELECT status, calculation_logic_version, reasons_json, limits_json, observation_point_count FROM estimation_results WHERE calculation_interval_ids_json = '["int-estimable"]'`).Scan(&status, &logicVersion, &reasonsJSON, &limitsJSON, &obsCount)
	if err != nil {
		t.Fatalf("query rebuilt estimable result: %v", err)
	}
	if status != string(domain.EstimationEstimated) || logicVersion != domain.CalculationLogicVersion || obsCount != 3 {
		t.Fatalf("rebuilt estimable result = status=%s logic=%s points=%d reasons=%s", status, logicVersion, obsCount, reasonsJSON)
	}
	var reasons []string
	if err := json.Unmarshal([]byte(reasonsJSON), &reasons); err != nil {
		t.Fatalf("decode rebuilt reasons: %v", err)
	}
	if len(reasons) != 1 || reasons[0] != domain.EstimationReasonPositiveUniqueSolution {
		t.Fatalf("rebuilt reasons = %#v", reasons)
	}
	var limits []float64
	if err := json.Unmarshal([]byte(limitsJSON), &limits); err != nil {
		t.Fatalf("decode rebuilt limits: %v", err)
	}
	if len(limits) != 1 || math.Abs(limits[0]-150) > 1e-9 {
		t.Fatalf("rebuilt limits = %#v, want [150]", limits)
	}

	var excludedStatus, excludedReason string
	if err := reopenedDB.QueryRowContext(ctx, `SELECT status, reasons_json FROM estimation_results WHERE calculation_interval_ids_json = '["int-excluded"]'`).Scan(&excludedStatus, &excludedReason); err != nil {
		t.Fatalf("query excluded result: %v", err)
	}
	if excludedStatus != string(domain.EstimationNotApplicable) || excludedReason != `["unsupported_cycle"]` {
		t.Fatalf("excluded result = status=%s reasons=%s", excludedStatus, excludedReason)
	}
	var insufficientStatus string
	if err := reopenedDB.QueryRowContext(ctx, `SELECT status FROM estimation_results WHERE calculation_interval_ids_json = '["int-insufficient"]'`).Scan(&insufficientStatus); err != nil {
		t.Fatalf("query insufficient result: %v", err)
	}
	if insufficientStatus != string(domain.EstimationInsufficient) {
		t.Fatalf("insufficient result status = %s", insufficientStatus)
	}
	for intervalID, status := range map[string]domain.EstimationStatus{
		"int-estimable":    domain.EstimationEstimated,
		"int-excluded":     domain.EstimationNotApplicable,
		"int-insufficient": domain.EstimationInsufficient,
	} {
		seriesCount := mustCount(t, reopenedDB, `SELECT count(*) FROM estimation_result_series WHERE estimation_result_id = (SELECT estimation_result_id FROM estimation_results WHERE calculation_interval_ids_json = ? AND status = ?)`, `[`+`"`+intervalID+`"`+`]`, string(status))
		if seriesCount != 1 {
			t.Fatalf("%s result series count = %d, want 1", intervalID, seriesCount)
		}
	}

	currentPointCount := mustCount(t, reopenedDB, `SELECT count(*) FROM estimation_points WHERE calculation_logic_version = ?`, domain.CalculationLogicVersion)
	legacyPointCount := mustCount(t, reopenedDB, `SELECT count(*) FROM estimation_points WHERE calculation_logic_version = ?`, legacyLogic)
	if currentPointCount != 3 || legacyPointCount != 0 {
		t.Fatalf("point versions = current %d legacy %d, want 3/0", currentPointCount, legacyPointCount)
	}
	for name, want := range immutableCounts {
		var query string
		switch name {
		case "cost observations":
			query = `SELECT count(*) FROM usage_cost_observations`
		case "limit observations":
			query = `SELECT count(*) FROM usage_limit_observations`
		case "limit links":
			query = `SELECT count(*) FROM usage_limit_source_links`
		case "cost links":
			query = `SELECT count(*) FROM usage_cost_source_account_links`
		case "plan histories":
			query = `SELECT count(*) FROM plan_histories`
		case "audits":
			query = `SELECT count(*) FROM configuration_audits`
		}
		if got := mustCount(t, reopenedDB, query); got != want {
			t.Fatalf("%s changed from %d to %d", name, want, got)
		}
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func mustCount(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), query, args...).Scan(&count); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return count
}
