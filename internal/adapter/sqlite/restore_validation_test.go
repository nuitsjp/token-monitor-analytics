package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestValidateRestoreDatabaseAcceptsCurrentEmptyDatabaseReadOnly(t *testing.T) {
	path := createRestoreTestDatabase(t)
	manifest := restoreManifestForPath(t, path)
	if err := (&Lifecycle{}).ValidateRestoreDatabase(context.Background(), path, manifest); err != nil {
		t.Fatalf("validate current restore database: %v", err)
	}
	for _, sidecar := range []string{path + "-wal", path + "-shm"} {
		if _, err := os.Stat(sidecar); !os.IsNotExist(err) {
			t.Fatalf("read-only validation created sidecar %q", sidecar)
		}
	}
}

func TestValidateRestoreDatabaseRejectsRequiredTableAndColumn(t *testing.T) {
	tests := []struct {
		name   string
		mutate string
	}{
		{name: "table", mutate: `DROP TABLE display_settings`},
		{name: "column", mutate: `ALTER TABLE hubs DROP COLUMN api_contract`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := createRestoreTestDatabase(t)
			execRestoreMutation(t, path, test.mutate)
			err := (&Lifecycle{}).ValidateRestoreDatabase(context.Background(), path, restoreManifestForPath(t, path))
			assertSQLiteRestoreCode(t, err, domain.RestoreValidationRequiredSchema)
		})
	}
}

func TestValidateRestoreDatabaseRejectsSemanticFailuresIndividually(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, string)
		code   domain.RestoreValidationCode
	}{
		{
			name: "enum",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `PRAGMA ignore_check_constraints = ON; UPDATE display_settings SET theme = 'invalid' WHERE singleton = 1`)
			},
			code: domain.RestoreValidationEnum,
		},
		{
			name: "datetime",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('hub', 'Hub', 'https://example.test', 0, 60, 'not-a-time', '2026-08-26T00:00:00Z')`)
			},
			code: domain.RestoreValidationDatetime,
		},
		{
			name: "foreign key",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `PRAGMA foreign_keys = OFF; INSERT INTO hub_connection_statuses (hub_id, state) VALUES ('missing', 'not_checked')`)
			},
			code: domain.RestoreValidationForeignKey,
		},
		{
			name: "interval overlap",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `
					DROP TRIGGER service_identifier_mappings_no_overlap_insert;
					INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at)
					VALUES ('service', 'Provider', 'Service', 'official', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
					INSERT INTO service_identifier_mappings (mapping_id, identifier_kind, raw_identifier, service_id, valid_from, valid_to, created_at)
					VALUES ('mapping-1', 'usage_cost', 'raw', 'service', '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-08-26T00:00:00Z');
					INSERT INTO service_identifier_mappings (mapping_id, identifier_kind, raw_identifier, service_id, valid_from, valid_to, created_at)
					VALUES ('mapping-2', 'usage_cost', 'raw', 'service', '2026-06-01T00:00:00Z', NULL, '2026-08-26T00:00:00Z');`)
			},
			code: domain.RestoreValidationInterval,
		},
		{
			name: "secret field",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `ALTER TABLE display_settings ADD COLUMN access_token TEXT`)
			},
			code: domain.RestoreValidationSecret,
		},
		{
			name: "unclassified raw JSON",
			mutate: func(t *testing.T, path string) {
				execRestoreMutation(t, path, `
					INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at)
					VALUES ('hub', 'Hub', 'https://example.test', 0, 60, '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
					INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds)
					VALUES ('attempt', 'hub', 'manual', 'succeeded', '2026-08-26T00:00:00Z', 60);
					INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body)
					VALUES ('snapshot', 'attempt', 'hub', 'stats', '2026-08-26T00:00:00Z', '2026-08-26T00:00:01Z', 200, CAST('{"devices":[{"accessToken":"sentinel"}]}' AS BLOB));`)
			},
			code: domain.RestoreValidationSecret,
		},
		{
			name:   "recalculation reproducibility",
			mutate: insertIrreproducibleRestoreResult,
			code:   domain.RestoreValidationRecalculation,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := createRestoreTestDatabase(t)
			test.mutate(t, path)
			err := (&Lifecycle{}).ValidateRestoreDatabase(context.Background(), path, restoreManifestForPath(t, path))
			assertSQLiteRestoreCode(t, err, test.code)
		})
	}
}

func TestValidateRestoreDatabaseRejectsSchemaVersionAndCorruption(t *testing.T) {
	t.Run("schema version", func(t *testing.T) {
		path := createRestoreTestDatabase(t)
		execRestoreMutation(t, path, `UPDATE schema_metadata SET schema_version = schema_version - 1 WHERE singleton = 1`)
		err := (&Lifecycle{}).ValidateRestoreDatabase(context.Background(), path, restoreManifestForPath(t, path))
		assertSQLiteRestoreCode(t, err, domain.RestoreValidationSchemaVersion)
	})
	t.Run("corruption", func(t *testing.T) {
		path := createRestoreTestDatabase(t)
		file, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteAt([]byte("not sqlite"), 0); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		err = (&Lifecycle{}).ValidateRestoreDatabase(context.Background(), path, restoreManifestForPath(t, path))
		assertSQLiteRestoreCode(t, err, domain.RestoreValidationIntegrity)
	})
}

func TestRunIsolatedRestoreTrialPreservesOperationalDatabaseAndComparesLogicalContent(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	operationalDirectory := filepath.Join(root, "operational")
	if err := os.Mkdir(operationalDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	operationalPath := filepath.Join(operationalDirectory, "data.sqlite3")
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(ctx, operationalPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	operationalBefore, err := logicalSnapshot(ctx, operationalPath)
	if err != nil {
		t.Fatal(err)
	}
	sourcePath := createRestoreTestDatabase(t)
	manifest := restoreManifestForPath(t, sourcePath)
	trialDirectory := filepath.Join(root, "isolated")
	if err := os.Mkdir(trialDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.RunIsolatedRestoreTrial(ctx, sourcePath, trialDirectory, manifest); err != nil {
		t.Fatalf("run isolated restore trial: %v", err)
	}
	operationalAfter, err := logicalSnapshot(ctx, operationalPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(operationalBefore, operationalAfter) {
		t.Fatal("operational database changed during isolated restore trial")
	}
	sourceSnapshot, err := logicalSnapshot(ctx, sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	isolatedSnapshot, err := logicalSnapshot(ctx, filepath.Join(trialDirectory, "data.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(sourceSnapshot, isolatedSnapshot) {
		t.Fatal("isolated database differs from source")
	}
}

func TestRunIsolatedRestoreTrialRevalidatesBoundDatabase(t *testing.T) {
	path := createRestoreTestDatabase(t)
	manifest := restoreManifestForPath(t, path)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("changed after validation")); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	trialDirectory := filepath.Join(t.TempDir(), "isolated")
	if err := os.Mkdir(trialDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	err = (&Lifecycle{}).RunIsolatedRestoreTrial(context.Background(), path, trialDirectory, manifest)
	assertSQLiteRestoreCode(t, err, domain.RestoreValidationDeclaredSize)
}

func createRestoreTestDatabase(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data.sqlite3")
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), path); err != nil {
		t.Fatalf("create restore test database: %v", err)
	}
	if err := lifecycle.Close(); err != nil {
		t.Fatalf("close restore test database: %v", err)
	}
	return path
}

func execRestoreMutation(t *testing.T, path, statement string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(statement); err != nil {
		_ = database.Close()
		t.Fatalf("mutate restore database: %v", err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
}

func restoreManifestForPath(t *testing.T, path string) domain.BackupManifest {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	return domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: CurrentSchemaVersion,
		AppVersion:    "test",
		CreatedAt:     time.Date(2026, 8, 26, 0, 0, 0, 0, time.UTC),
		Database: domain.BackupDatabaseManifest{
			Path:      "data.sqlite3",
			SizeBytes: int64(len(contents)),
			SHA256:    hex.EncodeToString(digest[:]),
		},
	}
}

func assertSQLiteRestoreCode(t *testing.T, err error, expected domain.RestoreValidationCode) {
	t.Helper()
	var validationErr *domain.RestoreValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("error = %v, want RestoreValidationError", err)
	}
	if validationErr.Code != expected {
		t.Fatalf("validation code = %q, want %q (error: %v)", validationErr.Code, expected, err)
	}
}

func insertIrreproducibleRestoreResult(t *testing.T, path string) {
	t.Helper()
	execRestoreMutation(t, path, `
		INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at)
		VALUES ('hub', 'Hub', 'https://example.test', 0, 60, '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at)
		VALUES ('service', 'Provider', 'Service', 'official', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at)
		VALUES ('definition', 'service', 'weekly', 'Weekly', 'percent', 'not_applicable', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at)
		VALUES ('account', 'service', 'Account', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at)
		VALUES ('source', 'hub', 'device', 'account-key', 'raw', 'window', 'weekly', 'percent', 'Weekly', '2026-08-26T00:00:00Z');
		INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at)
		VALUES ('interval', 'service', 'account', 'source', 'definition', 'weekly', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', 'estimable', '', '[]', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO estimation_points (estimation_point_id, service_id, limit_definition_id, cycle_type, calculation_interval_id, calculation_interval_ids_json, reference_at, shared_cost, utilization_json, limit_series_ids_json, limit_series_logical_account_ids_json, limit_series_plan_version_ids_json, limit_series_calculation_interval_ids_json, cost_source_ids_json, association_ids_json, completeness_ids_json, matching_rule_version, calculation_logic_version, created_at, updated_at)
		VALUES ('point', 'service', 'definition', 'weekly', 'interval', '["interval"]', '2026-01-02T00:00:00Z', 10, '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', 'matching-v1', 'logic-v1', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');
		INSERT INTO estimation_results (estimation_result_id, result_set_key, service_id, limit_definition_id, cycle_type, calculation_interval_ids_json, valid_from, valid_to, status, reasons_json, limits_json, observation_point_count, difference_row_count, rank, absolute_error_ratio, max_time_delta_ns, calculation_logic_version, matching_rule_version, input_fingerprint, created_at, updated_at)
		VALUES ('result', 'result-key', 'service', 'definition', 'weekly', '["interval"]', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', 'verified', '[]', '[100]', 1, 0, 1, 0, 0, 'logic-v1', 'matching-v1', 'not-reproducible', '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z');`)
}
