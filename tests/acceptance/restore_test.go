package acceptance

import (
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/adapter/backupzip"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
	"token-monitor-analytics/internal/domain"
	"token-monitor-analytics/internal/usecase"
)

type restoreClock struct{ value time.Time }

func (c restoreClock) Now() time.Time { return c.value }

type restoreIDs struct{ value string }

func (g restoreIDs) New() string { return g.value }

type stoppedCollection struct{}

func (stoppedCollection) Suspend(context.Context) (bool, error) { return false, nil }
func (stoppedCollection) Resume(context.Context) error          { return nil }

func TestACP123RestoreRepresentativeDatabaseFullRoundTrip(t *testing.T) {
	t.Run("AC-P1-23", runRestoreRepresentativeDatabaseFullRoundTrip)
}

func runRestoreRepresentativeDatabaseFullRoundTrip(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	dataDirectory := filepath.Join(workspace, "application-data")
	if err := os.Mkdir(dataDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	lifecycle := &sqliteadapter.Lifecycle{}
	if err := lifecycle.Open(ctx, filepath.Join(dataDirectory, sqliteadapter.RestoreDatabaseName)); err != nil {
		t.Fatal(err)
	}
	defer lifecycle.Close()
	gate := usecase.NewMaintenanceGate()
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	seedRepresentativeRestoreData(t, ctx, lifecycle, database)
	before, err := acceptanceLogicalContents(ctx, database, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-DATA-01 representative local database persists source and canonical records", func(t *testing.T) {
		for _, table := range []string{
			"raw_snapshots", "usage_cost_observations", "usage_limit_observations",
			"usage_cost_source_account_links", "usage_limit_source_links", "services",
			"logical_accounts", "plan_histories", "configuration_audits",
		} {
			if len(before[table]) == 0 {
				t.Fatalf("representative table %s has no persisted rows", table)
			}
		}
	})
	writer, err := backupzip.NewWriter()
	if err != nil {
		t.Fatal(err)
	}
	createdAt := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	backup, err := usecase.NewBackupUsecase(lifecycle, writer, nil, restoreClock{value: createdAt}, "acceptance", gate)
	if err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(workspace, "representative-round-trip.zip")
	if _, err := backup.CreateBackup(ctx, archivePath, nil); err != nil {
		t.Fatal(err)
	}
	validation, err := usecase.NewRestoreValidationUsecase(lifecycle, backupzip.NewValidator(), nil, restoreClock{value: createdAt}, restoreIDs{value: "operation-acceptance"}, gate)
	if err != nil {
		t.Fatal(err)
	}
	validated, err := validation.ValidateArchive(ctx, archivePath)
	if err != nil {
		t.Fatal(err)
	}
	applier, err := sqliteadapter.NewRestoreApplier(lifecycle, nil)
	if err != nil {
		t.Fatal(err)
	}
	apply, err := usecase.NewRestoreApplyUsecase(validation, applier, stoppedCollection{}, restoreClock{value: createdAt.Add(time.Hour)}, restoreIDs{value: "audit-acceptance"}, gate)
	if err != nil {
		t.Fatal(err)
	}
	result, err := apply.Apply(ctx, validated.OperationID, true)
	if err != nil {
		t.Fatal(err)
	}
	if result.Warning != "" {
		t.Fatalf("restore warning = %q", result.Warning)
	}
	database, err = lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	after, err := acceptanceLogicalContents(ctx, database, result.AuditID)
	if err != nil {
		t.Fatal(err)
	}
	t.Run("P1-BACKUP-03 online backup carries representative database contents", func(t *testing.T) {
		if validated.FormatVersion != domain.BackupFormatVersion || validated.SchemaVersion != sqliteadapter.CurrentSchemaVersion || validated.ArtifactSHA256 == "" {
			t.Fatalf("validated backup metadata = %#v", validated)
		}
		for _, table := range []string{"raw_snapshots", "usage_cost_observations", "usage_limit_observations", "services", "logical_accounts", "plan_histories", "configuration_audits"} {
			if !reflect.DeepEqual(before[table], after[table]) {
				t.Fatalf("backup round trip changed representative table %s", table)
			}
		}
	})
	t.Run("P1-RESTORE-07 empty-database round trip compares counts and history", func(t *testing.T) {
		if !reflect.DeepEqual(before, after) {
			t.Fatal("logical database contents differ after excluding the one restore audit")
		}
		var total, restores int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits`).Scan(&total); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM configuration_audits WHERE action = 'restore_succeeded' AND entity_type = 'restore'`).Scan(&restores); err != nil {
			t.Fatal(err)
		}
		if total != 2 || restores != 1 {
			t.Fatalf("configuration audits total/restore = %d/%d, want 2/1", total, restores)
		}
	})
}

func seedRepresentativeRestoreData(t *testing.T, ctx context.Context, lifecycle *sqliteadapter.Lifecycle, database *sql.DB) {
	t.Helper()
	now := time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC)
	until := now.Add(7 * 24 * time.Hour)
	rawBody := []byte(`{"devices":[{"deviceId":"device-acceptance","usageUpdatedAt":"2026-08-26T00:00:00Z","syncUploadIntervalMs":60000,"periodWindows":{"timeZone":"UTC","today":{"key":"2026-08-26"}},"periods":{"allTime":{"clientCosts":{"service.acceptance":"12.5"}}},"limits":{"refreshMs":60000,"providers":[{"provider":"provider","accountKey":"account-key","updatedAt":"2026-08-26T00:00:00Z","planLabel":"Representative Plan","windows":[{"kind":"weekly","metric":"percent","label":"Weekly","usedPercent":25,"resetsAt":"2026-09-02T00:00:00Z"}]}]}}]}`)
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, api_contract, created_at, updated_at) VALUES ('hub-acceptance', 'Representative Hub', 'https://hub.example.test', 0, 300, 'v1', ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('service-acceptance', 'provider', 'Representative Service', 'service.acceptance', ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('definition-acceptance', 'service-acceptance', 'weekly', 'Weekly use', 'percent', 'not_applicable', ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES ('plan-acceptance', 'service-acceptance', 'Representative Plan', 1, ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, valid_to, official_source_url, created_at) VALUES ('plan-version-acceptance', 'plan-acceptance', '2026', ?, NULL, 'https://catalog.example.test/plan', ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('account-acceptance', 'service-acceptance', 'Representative Account', ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, completed_at, analytics_interval_seconds, stats_http_status, api_contract, stats_snapshot_id) VALUES ('attempt-acceptance', 'hub-acceptance', 'manual', 'succeeded', ?, ?, 300, 200, 'v1', 'snapshot-acceptance')`, []any{now.Format(time.RFC3339), now.Add(time.Second).Format(time.RFC3339)}},
		{`INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, api_contract, body) VALUES ('snapshot-acceptance', 'attempt-acceptance', 'hub-acceptance', 'stats', ?, ?, 200, 'v1', ?)`, []any{now.Format(time.RFC3339), now.Add(time.Second).Format(time.RFC3339), rawBody}},
		{`INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, sync_upload_interval_ms, analytics_interval_seconds, source_timezone, source_local_date, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('cost-observation-acceptance', 'snapshot-acceptance', 'hub-acceptance', 'device-acceptance', 'service.acceptance', ?, '12.5', 60000, 300, 'UTC', '2026-08-26', 1, 'normalization-v1', 'normalization-logic-v1', '$.devices[0].periods.allTime.clientCosts.service.acceptance', 'canonical', 'cost-key', 'cost-fingerprint')`, []any{now.Format(time.RFC3339)}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at, sync_upload_interval_ms, limits_refresh_ms, analytics_interval_seconds, source_timezone, source_local_date, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('limit-observation-acceptance', 'snapshot-acceptance', 'hub-acceptance', 'device-acceptance', 'service.acceptance', 'account-key', ?, 'weekly', 'weekly', 'percent', 'Weekly', 'Representative Plan', 25, ?, 60000, 60000, 300, 'UTC', '2026-08-26', 1, 'normalization-v1', 'normalization-logic-v1', '$.devices[0].limits.providers[0].windows[0]', 'canonical', 'limit-key', 'limit-fingerprint')`, []any{now.Format(time.RFC3339), until.Format(time.RFC3339)}},
		{`INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cost-source-acceptance', 'hub-acceptance', 'device-acceptance', 'service.acceptance', ?)`, []any{now.Format(time.RFC3339)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('limit-source-acceptance', 'hub-acceptance', 'device-acceptance', 'account-key', 'service.acceptance', 'weekly', 'weekly', 'percent', 'Weekly', ?)`, []any{now.Format(time.RFC3339)}},
		{`INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at) VALUES ('cost-association-acceptance', 'cost-source-acceptance', 'account-acceptance', ?, NULL, ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at) VALUES ('limit-association-acceptance', 'limit-source-acceptance', 'account-acceptance', 'definition-acceptance', ?, NULL, ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at) VALUES ('plan-history-acceptance', 'account-acceptance', 'plan-version-acceptance', ?, NULL, ?, ?)`, []any{now.Format(time.RFC3339), now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('interval-acceptance', 'service-acceptance', 'account-acceptance', 'limit-source-acceptance', 'definition-acceptance', 'plan-version-acceptance', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, []any{now.Format(time.RFC3339), until.Format(time.RFC3339), now.Format(time.RFC3339), now.Format(time.RFC3339)}},
		{`INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json) VALUES ('catalog-audit-acceptance', ?, 'test', 'catalog_change', 'service', 'service-acceptance', '{}', '{}')`, []any{now.Format(time.RFC3339)}},
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatalf("seed representative restore data: %v", err)
		}
	}
	syncInterval := int64(60000)
	refreshInterval := int64(60000)
	point := domain.EstimationPoint{
		ID: "point-acceptance", ServiceID: "service-acceptance", LimitDefinitionID: "definition-acceptance",
		PlanVersionID: "plan-version-acceptance", CycleType: "weekly", CalculationIntervalID: "interval-acceptance",
		CalculationIntervalIDs: []string{"interval-acceptance"}, ReferenceAt: now.Add(time.Hour), SharedCost: 12.5,
		Utilization: []float64{0.25}, LimitSeriesIDs: []string{"limit-source-acceptance"},
		LimitSeriesLogicalAccountIDs: []string{"account-acceptance"}, LimitSeriesPlanVersionIDs: []string{"plan-version-acceptance"},
		LimitSeriesCalculationIntervalIDs: []string{"interval-acceptance"}, CostSourceIDs: []string{"cost-source-acceptance"},
		AssociationIDs: []string{"cost-association-acceptance", "limit-association-acceptance"}, MatchingRuleVersion: "matching-v1",
		CalculationLogicVersion: domain.CalculationLogicVersion, CreatedAt: now, UpdatedAt: now,
		MatchedObservations: []domain.MatchedObservation{
			{ID: "matched-limit-acceptance", Role: domain.MatchingRoleLimit, SourceID: "limit-source-acceptance", LogicalAccountID: "account-acceptance", ObservationID: "limit-observation-acceptance", ObservedAt: now, Tolerance: time.Minute, AnalyticsIntervalSeconds: 300, SyncUploadIntervalMS: &syncInterval, LimitsRefreshMS: &refreshInterval, NormalizationGeneration: 1, NormalizationRuleVersion: "normalization-v1", NormalizationLogicVersion: "normalization-logic-v1"},
			{ID: "matched-cost-acceptance", Role: domain.MatchingRoleCost, SourceID: "cost-source-acceptance", LogicalAccountID: "account-acceptance", ObservationID: "cost-observation-acceptance", ObservedAt: now, Tolerance: time.Minute, AnalyticsIntervalSeconds: 300, SyncUploadIntervalMS: &syncInterval, NormalizationGeneration: 1, NormalizationRuleVersion: "normalization-v1", NormalizationLogicVersion: "normalization-logic-v1"},
		},
	}
	if err := lifecycle.SaveEstimationPoints(ctx, []domain.EstimationPoint{point}); err != nil {
		t.Fatal(err)
	}
	input, err := lifecycle.ListEstimationInput(ctx, point.CalculationIntervalID)
	if err != nil {
		t.Fatal(err)
	}
	estimation, err := domain.EstimateFromPoints(input)
	if err != nil {
		t.Fatal(err)
	}
	result := domain.DerivedResult{
		ID: "result-acceptance", ServiceID: point.ServiceID, LimitDefinitionID: point.LimitDefinitionID,
		CycleType: point.CycleType, CalculationIntervalIDs: point.CalculationIntervalIDs,
		ValidFrom: now, ValidTo: until, EstimationResult: estimation, Points: input.Points, Intervals: input.Intervals,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := lifecycle.SaveDerivedResult(ctx, result, nil); err != nil {
		t.Fatal(err)
	}
	resultKey := domain.ResultSetKey(result.ServiceID, result.LimitDefinitionID, result.CycleType, result.ValidFrom, result.ValidTo, result.CalculationIntervalIDs)
	stored, err := lifecycle.GetEstimationResult(ctx, resultKey)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, err := domain.ComputeInputFingerprint(input.Points, estimation.DifferenceRows, stored.Evidence, estimation.SeriesMultipliers, estimation.PlanLimitRuleIDs, stored.MatchingRuleVersion, estimation.CalculationLogicVersion, estimation.PlanLimitRules...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE estimation_results SET input_fingerprint = ? WHERE estimation_result_id = ?`, fingerprint, stored.ID); err != nil {
		t.Fatal(err)
	}
	var evidence int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM estimation_result_evidence WHERE evidence_kind IN ('association', 'plan_history', 'snapshot')`).Scan(&evidence); err != nil {
		t.Fatal(err)
	}
	if evidence < 3 {
		t.Fatalf("representative estimation evidence count = %d, want at least 3", evidence)
	}
}

func acceptanceLogicalContents(ctx context.Context, database *sql.DB, excludedAuditID string) (map[string][][]string, error) {
	tableRows, err := database.QueryContext(ctx, `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for tableRows.Next() {
		var table string
		if err := tableRows.Scan(&table); err != nil {
			_ = tableRows.Close()
			return nil, err
		}
		tables = append(tables, table)
	}
	if err := tableRows.Err(); err != nil {
		_ = tableRows.Close()
		return nil, err
	}
	if err := tableRows.Close(); err != nil {
		return nil, err
	}
	result := make(map[string][][]string, len(tables))
	for _, table := range tables {
		columns, primary, err := acceptanceColumns(ctx, database, table)
		if err != nil {
			return nil, err
		}
		order := primary
		if len(order) == 0 {
			order = columns
		}
		query := `SELECT ` + joinAcceptanceIdentifiers(columns) + ` FROM ` + acceptanceIdentifier(table)
		var arguments []any
		if table == "configuration_audits" && excludedAuditID != "" {
			query += ` WHERE audit_id <> ?`
			arguments = append(arguments, excludedAuditID)
		}
		query += ` ORDER BY ` + joinAcceptanceIdentifiers(order)
		rows, err := database.QueryContext(ctx, query, arguments...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				_ = rows.Close()
				return nil, err
			}
			encoded := make([]string, len(values))
			for i, value := range values {
				if bytes, ok := value.([]byte); ok {
					encoded[i] = "bytes:" + hex.EncodeToString(bytes)
				} else {
					encoded[i] = fmt.Sprintf("%T:%v", value, value)
				}
			}
			result[table] = append(result[table], encoded)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func acceptanceColumns(ctx context.Context, database *sql.DB, table string) ([]string, []string, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA table_info(`+acceptanceIdentifier(table)+`)`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var columns []string
	primaryByPosition := make(map[int]string)
	for rows.Next() {
		var position, notNull, primary int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&position, &name, &columnType, &notNull, &defaultValue, &primary); err != nil {
			return nil, nil, err
		}
		columns = append(columns, name)
		if primary > 0 {
			primaryByPosition[primary] = name
		}
	}
	positions := make([]int, 0, len(primaryByPosition))
	for position := range primaryByPosition {
		positions = append(positions, position)
	}
	sort.Ints(positions)
	primary := make([]string, 0, len(positions))
	for _, position := range positions {
		primary = append(primary, primaryByPosition[position])
	}
	return columns, primary, rows.Err()
}

func joinAcceptanceIdentifiers(values []string) string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = acceptanceIdentifier(value)
	}
	return strings.Join(quoted, `, `)
}

func acceptanceIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
