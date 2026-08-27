package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

type purgeFailureInjector func(string) error

func (f purgeFailureInjector) Check(point string) error { return f(point) }

func TestPreviewAndPurgeUseSnapshotReceivedCompletionHalfOpenSelection(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	start := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	hubA := insertPurgeHub(t, lifecycle, uuid.NewString(), start)
	hubB := insertPurgeHub(t, lifecycle, uuid.NewString(), start)
	insertPurgeSnapshot(t, lifecycle, hubA, "a-in", start.Add(time.Minute), []byte("alpha"))
	insertPurgeSnapshot(t, lifecycle, hubA, "a-end", start.Add(time.Hour), []byte("excluded"))
	insertPurgeSnapshot(t, lifecycle, hubB, "b-in", start.Add(2*time.Minute), []byte("bravo"))
	periodEnd := start.Add(time.Hour)
	var preview domain.PurgePreview
	t.Run("P1-PURGE-01 Hub set and half-open completion interval", func(t *testing.T) {
		var err error
		preview, err = lifecycle.PreviewPurge(ctx, domain.PurgeSelection{HubIDs: []string{hubA}, Start: &start, End: &periodEnd})
		if err != nil {
			t.Fatal(err)
		}
		if preview.Capacity.RawSnapshotCount != 1 || preview.Capacity.RawJSONBytes != int64(len("alpha")) || !preview.Capacity.OldestCompletedAt.Equal(start.Add(time.Minute)) || !preview.Capacity.LatestCompletedAt.Equal(start.Add(time.Minute)) {
			t.Fatalf("preview = %#v", preview)
		}
		allHubs, err := lifecycle.PreviewPurge(ctx, domain.PurgeSelection{AllHubs: true})
		if err != nil {
			t.Fatal(err)
		}
		if allHubs.Capacity.RawSnapshotCount != 3 || allHubs.Capacity.RawJSONBytes != int64(len("alpha")+len("excluded")+len("bravo")) {
			t.Fatalf("all-hub unbounded preview = %#v", allHubs)
		}
	})
	result, err := lifecycle.Purge(ctx, preview.Selection, start.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if result.RawSnapshotCount != 1 || result.AuditID == "" {
		t.Fatalf("purge result = %#v", result)
	}
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	assertPurgeCount(t, database, "raw_snapshots", 2)
	assertPurgeCount(t, database, "collection_attempts", 3)
	var auditCount int
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM configuration_audits WHERE action = 'data_purge'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("purge audits = %d, want 1", auditCount)
	}
}

func TestPurgeFailureRollsBackLogicalDatabase(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	hubID := insertPurgeHub(t, lifecycle, uuid.NewString(), now)
	insertPurgeSnapshot(t, lifecycle, hubID, "failure-snapshot", now, []byte("failure-body"))
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	before, err := purgeLogicalDump(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	selection := domain.PurgeSelection{HubIDs: []string{hubID}}
	t.Run("P1-PURGE-05 rollback preserves local canonical database", func(t *testing.T) {
		for _, injectedPoint := range []string{"after-selection", "after-dependency-selection", "after-results", "after-points", "after-intervals", "after-observations", "after-recalculation", "before-commit"} {
			_, err = lifecycle.purgeWithInjector(ctx, selection, now.Add(time.Hour), purgeFailureInjector(func(point string) error {
				if point == injectedPoint {
					return errors.New("injected purge failure")
				}
				return nil
			}))
			if err == nil {
				t.Fatalf("purge failure injection %q succeeded", injectedPoint)
			}
			after, dumpErr := purgeLogicalDump(ctx, database)
			if dumpErr != nil {
				t.Fatal(dumpErr)
			}
			if before != after {
				t.Fatalf("logical dump changed after rollback at %s: before=%s after=%s", injectedPoint, before, after)
			}
		}
	})
}

func TestPurgeRemovesDependentDerivedDataAndKeepsConfiguration(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	ctx := context.Background()
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	hubID := insertPurgeHub(t, lifecycle, uuid.NewString(), now)
	insertPurgeSnapshot(t, lifecycle, hubID, "dependent-snapshot", now, []byte("dependent"))
	retainedAt := now.Add(2 * time.Hour)
	insertPurgeSnapshot(t, lifecycle, hubID, "retained-snapshot", retainedAt, []byte("retained"))
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	insertPurgeDependentFixture(t, database, hubID, now)
	insertPurgeRetainedPointFixture(t, database, retainedAt)
	periodEnd := now.Add(time.Hour)
	result, err := lifecycle.Purge(ctx, domain.PurgeSelection{HubIDs: []string{hubID}, Start: &now, End: &periodEnd}, now.Add(3*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-PURGE-03 deletes selected snapshot dependencies as one unit", func(t *testing.T) {
		if result.EstimationResultCount != 1 || result.EstimationEvidenceCount != 2 || result.EstimationPointCount != 1 || result.CalculationIntervalCount != 0 || result.CalculationBoundaryCount != 0 || result.RecalculatedResultCount != 1 {
			t.Fatalf("dependent purge result = %#v", result)
		}
		for _, table := range []string{"raw_snapshots", "usage_cost_observations", "usage_limit_observations", "matched_observations", "estimation_points", "estimation_results", "estimation_result_evidence", "calculation_intervals", "calculation_boundaries"} {
			want := 1
			if table == "matched_observations" {
				want = 2
			}
			if table == "estimation_result_evidence" {
				want = 7
			}
			assertPurgeCount(t, database, table, want)
		}
	})
	var resultStatus string
	if err := database.QueryRowContext(t.Context(), `SELECT status FROM estimation_results WHERE estimation_result_id <> 'purge-result'`).Scan(&resultStatus); err != nil {
		t.Fatal(err)
	}
	if resultStatus != string(domain.EstimationInsufficient) {
		t.Fatalf("recalculated result status = %s", resultStatus)
	}
	t.Run("P1-PURGE-04 retains configuration and recalculates retained data", func(t *testing.T) {
		if result.RecalculatedResultCount != 1 {
			t.Fatalf("recalculated result count = %d, want 1", result.RecalculatedResultCount)
		}
		var resultStatus string
		if err := database.QueryRowContext(t.Context(), `SELECT status FROM estimation_results WHERE estimation_result_id <> 'purge-result'`).Scan(&resultStatus); err != nil {
			t.Fatal(err)
		}
		if resultStatus != string(domain.EstimationInsufficient) {
			t.Fatalf("recalculated result status = %s", resultStatus)
		}
		for _, table := range []string{"hubs", "collection_attempts", "services", "limit_definitions", "plans", "plan_versions", "plan_histories", "logical_accounts", "usage_cost_source_account_links", "usage_limit_source_links", "usage_cost_source_completeness", "configuration_audits"} {
			var count int
			if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == 0 {
				t.Fatalf("%s was removed by purge", table)
			}
		}
	})
}

func insertPurgeRetainedPointFixture(t *testing.T, database *sql.DB, observedAt time.Time) {
	t.Helper()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('retained-cost-observation', 'retained-snapshot', (SELECT hub_id FROM raw_snapshots WHERE snapshot_id = 'retained-snapshot'), 'cost-device', 'cost.raw', ?, '2', 300, 1, 'rule', 'logic', '$.cost', 'canonical', 'retained-cost-key', 'retained')`, []any{utcText(observedAt)}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('retained-limit-observation', 'retained-snapshot', (SELECT hub_id FROM raw_snapshots WHERE snapshot_id = 'retained-snapshot'), 'limit-device', 'limit.raw', 'account-key', ?, 'weekly', 'weekly', 'percent', 'Weekly', 'Plan', 300, 1, 'rule', 'logic', '$.limit', 'canonical', 'retained-limit-key', 'retained')`, []any{utcText(observedAt)}},
		{`INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at) VALUES ('retained-point', 'purge-service', 'purge-definition', 'weekly', 'purge-interval', '["purge-interval"]', ?, 1, '[0.2]', '["purge-limit-source"]', '["purge-account"]', '[""]', '["purge-interval"]', '["purge-cost-source"]', '["purge-cost-association","purge-limit-association"]', '["purge-completeness"]', 'match-rule', 'logic', ?, ?)`, []any{utcText(observedAt), utcText(observedAt), utcText(observedAt)}},
		{`INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('retained-matched-cost', 'retained-point', 'cost', 'purge-cost-source', 'purge-account', 'retained-cost-observation', ?, 0, 100, 300, 0, 1, 'rule', 'logic')`, []any{utcText(observedAt)}},
		{`INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('retained-matched-limit', 'retained-point', 'limit', 'purge-limit-source', 'purge-account', 'retained-limit-observation', ?, 0, 100, 300, 0, 10, 1, 'rule', 'logic')`, []any{utcText(observedAt)}},
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("insert retained purge fixture: %v", err)
		}
	}
}

func insertPurgeDependentFixture(t *testing.T, database *sql.DB, hubID string, now time.Time) {
	t.Helper()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('purge-service', 'provider', 'Purge Service', 'purge.service', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('purge-definition', 'purge-service', 'weekly', 'tokens', 'percent', 'not_applicable', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES ('purge-plan', 'purge-service', 'Purge Plan', 0, ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, valid_to, official_source_url, created_at) VALUES ('purge-plan-version', 'purge-plan', 'Purge Plan v1', ?, ?, 'https://example.test/purge-plan', ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('purge-account', 'purge-service', 'Purge Account', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at) VALUES ('purge-plan-history', 'purge-account', 'purge-plan-version', ?, ?, ?, ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('purge-cost-source', ?, 'cost-device', 'cost.raw', ?)`, []any{hubID, utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('purge-limit-source', ?, 'limit-device', 'account-key', 'limit.raw', 'weekly', 'weekly', 'percent', 'Weekly', ?)`, []any{hubID, utcText(now)}},
		{`INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, created_at, updated_at) VALUES ('purge-cost-association', 'purge-cost-source', 'purge-account', ?, ?, ?)`, []any{utcText(now), utcText(now), utcText(now)}},
		{`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at) VALUES ('purge-limit-association', 'purge-limit-source', 'purge-account', 'purge-definition', ?, ?, ?)`, []any{utcText(now), utcText(now), utcText(now)}},
		{`INSERT INTO usage_cost_source_completeness (completeness_id, usage_cost_source_id, valid_from, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at) VALUES ('purge-completeness', 'purge-cost-source', ?, 'confirmed', '["purge-account"]', '[]', ?, ?)`, []any{utcText(now), utcText(now), utcText(now)}},
		{`INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('purge-cost-observation', 'dependent-snapshot', ?, 'cost-device', 'cost.raw', ?, '1', 300, 1, 'rule', 'logic', '$.cost', 'canonical', 'purge-cost-key', 'value')`, []any{hubID, utcText(now)}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('purge-limit-observation', 'dependent-snapshot', ?, 'limit-device', 'limit.raw', 'account-key', ?, 'weekly', 'weekly', 'percent', 'Weekly', 'Plan', 300, 1, 'rule', 'logic', '$.limit', 'canonical', 'purge-limit-key', 'value')`, []any{hubID, utcText(now)}},
		{`INSERT INTO calculation_boundaries (calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id, boundary_at, boundary_kind, reason, created_at) VALUES ('purge-boundary', 'purge-service', 'purge-account', 'purge-limit-source', ?, 'reset', 'reset', ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('purge-interval', 'purge-service', 'purge-account', 'purge-limit-source', 'purge-definition', 'weekly', ?, ?, 'estimable', '', '["purge-boundary"]', ?, ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at) VALUES ('purge-point', 'purge-service', 'purge-definition', 'weekly', 'purge-interval', '["purge-interval"]', ?, 0, '[0.1]', '["purge-limit-source"]', '["purge-account"]', '[""]', '["purge-interval"]', '["purge-cost-source"]', '["purge-cost-association","purge-limit-association"]', '["purge-completeness"]', 'match-rule', 'logic', ?, ?)`, []any{utcText(now), utcText(now), utcText(now)}},
		{`INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('purge-matched-cost', 'purge-point', 'cost', 'purge-cost-source', 'purge-account', 'purge-cost-observation', ?, 0, 100, 300, 0, 1, 'rule', 'logic')`, []any{utcText(now)}},
		{`INSERT INTO matched_observations (matched_observation_id, estimation_point_id, observation_role, source_id, logical_account_id, observation_id, observed_at, time_delta_ns, tolerance_ns, analytics_interval_seconds, sync_upload_interval_ms, limits_refresh_ms, normalization_generation, normalization_rule_version, normalization_logic_version) VALUES ('purge-matched-limit', 'purge-point', 'limit', 'purge-limit-source', 'purge-account', 'purge-limit-observation', ?, 0, 100, 300, 0, 10, 1, 'rule', 'logic')`, []any{utcText(now)}},
		{`INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at) VALUES ('purge-result', 'purge-result-key', 'purge-service', 'purge-definition', 'weekly', '["purge-interval"]', ?, ?, 'uncomputed', '["test"]', '[]', 1, 0, 0, 0, 0, 'logic', 'match-rule', 'fingerprint', ?, ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO estimation_result_evidence (estimation_result_evidence_id, estimation_result_id, evidence_kind, point_id) VALUES ('purge-evidence-point', 'purge-result', 'point', 'purge-point')`, nil},
		{`INSERT INTO estimation_result_evidence (estimation_result_evidence_id, estimation_result_id, evidence_kind, point_id, observation_id, snapshot_id) VALUES ('purge-evidence-snapshot', 'purge-result', 'snapshot', 'purge-point', 'purge-cost-observation', 'dependent-snapshot')`, nil},
		{`INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id) VALUES ('purge-existing-audit', ?, 'test', 'catalog_change', 'service', 'purge-service')`, []any{utcText(now)}},
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatalf("insert purge fixture: %v", err)
		}
	}
}

func insertPurgeHub(t *testing.T, lifecycle *Lifecycle, hubID string, now time.Time) string {
	t.Helper()
	if err := lifecycle.CreateHub(context.Background(), Hub{ID: hubID, DisplayName: hubID, URL: "https://" + hubID + ".example", CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return hubID
}

func insertPurgeSnapshot(t *testing.T, lifecycle *Lifecycle, hubID, snapshotID string, completedAt time.Time, body []byte) {
	t.Helper()
	attemptID := "attempt-" + snapshotID
	if err := lifecycle.CreateCollectionAttempt(context.Background(), CollectionAttempt{AttemptID: attemptID, HubID: hubID, Trigger: "manual", State: "started", StartedAt: completedAt.Add(-time.Second), AnalyticsIntervalSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SaveRawSnapshot(context.Background(), RawSnapshot{SnapshotID: snapshotID, AttemptID: attemptID, HubID: hubID, ResponseKind: "stats", ReceivedStartedAt: completedAt.Add(-time.Second), ReceivedCompletedAt: completedAt, HTTPStatus: 200, Body: body}); err != nil {
		t.Fatal(err)
	}
	attemptCompletedAt := completedAt.Add(time.Hour)
	if err := lifecycle.FinishCollectionAttempt(context.Background(), CollectionAttempt{AttemptID: attemptID, State: "succeeded", CompletedAt: &attemptCompletedAt}); err != nil {
		t.Fatal(err)
	}
}

func assertPurgeCount(t *testing.T, database *sql.DB, table string, want int) {
	t.Helper()
	var count int
	if err := database.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM `+table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("%s count = %d, want %d", table, count, want)
	}
}

func purgeLogicalDump(ctx context.Context, database *sql.DB) (string, error) {
	tables, err := database.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return "", err
	}
	defer func() { _ = tables.Close() }()
	var names []string
	for tables.Next() {
		var name string
		if err := tables.Scan(&name); err != nil {
			return "", err
		}
		names = append(names, name)
	}
	if err := tables.Err(); err != nil {
		return "", err
	}
	var lines []string
	for _, table := range names {
		orderBy, err := purgePrimaryKeyOrder(ctx, database, table)
		if err != nil {
			return "", err
		}
		query := `SELECT * FROM "` + strings.ReplaceAll(table, `"`, `""`) + `"` + orderBy
		tableLines, err := purgeTableDumpLines(ctx, database, table, query)
		if err != nil {
			return "", err
		}
		lines = append(lines, tableLines...)
	}
	hash := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(hash[:]), nil
}

func purgeTableDumpLines(ctx context.Context, database *sql.DB, table, query string) ([]string, error) {
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	var lines []string
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(values))
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		parts := make([]string, len(values))
		for index, value := range values {
			parts[index] = fmt.Sprintf("%T:%v", value, value)
		}
		lines = append(lines, table+"|"+strings.Join(parts, "|"))
	}
	return lines, rows.Err()
}

func purgePrimaryKeyOrder(ctx context.Context, database *sql.DB, table string) (string, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA table_info("`+strings.ReplaceAll(table, `"`, `""`)+`")`)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	type keyColumn struct {
		name string
		seq  int
	}
	var keys []keyColumn
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return "", err
		}
		if primaryKey > 0 {
			keys = append(keys, keyColumn{name: name, seq: primaryKey})
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].seq < keys[j].seq })
	if len(keys) == 0 {
		return "", nil
	}
	columns := make([]string, len(keys))
	for index, key := range keys {
		columns[index] = `"` + strings.ReplaceAll(key.name, `"`, `""`) + `"`
	}
	return " ORDER BY " + strings.Join(columns, ","), nil
}
