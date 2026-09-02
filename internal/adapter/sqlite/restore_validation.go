package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	modernsqlite "modernc.org/sqlite"
	"token-monitor-analytics/internal/domain"
)

type schemaColumn struct {
	Name    string
	Type    string
	NotNull int
	Primary int
}

type intervalContract struct {
	Table        string
	ID           string
	GroupColumns []string
}

var restoreIntervalContracts = []intervalContract{
	{Table: "service_identifier_mappings", ID: "mapping_id", GroupColumns: []string{"identifier_kind", "raw_identifier"}},
	{Table: "plan_versions", ID: "plan_version_id", GroupColumns: []string{"plan_id"}},
	{Table: "standard_prices", ID: "standard_price_id", GroupColumns: []string{"plan_version_id"}},
	{Table: "plan_histories", ID: "plan_history_id", GroupColumns: []string{"logical_account_id"}},
	{Table: "usage_cost_source_account_links", ID: "usage_cost_association_id", GroupColumns: []string{"usage_cost_source_id", "logical_account_id"}},
	{Table: "usage_limit_source_links", ID: "usage_limit_association_id", GroupColumns: []string{"usage_limit_source_id"}},
	{Table: "usage_cost_source_completeness", ID: "completeness_id", GroupColumns: []string{"usage_cost_source_id"}},
	{Table: "calculation_intervals", ID: "calculation_interval_id", GroupColumns: []string{"usage_limit_source_id", "logical_account_id", "limit_definition_id"}},
}

var restoreEnumContracts = map[string]map[string][]string{
	"display_settings": {
		"theme": {"light", "dark", "system"},
	},
	"recalculation_requests": {
		"state": {"pending", "running", "succeeded", "failed"},
	},
	"hub_connection_statuses": {
		"state": {"not_checked", "connected", "unreachable", "timeout", "tls_error", "authentication_failed", "unsupported_contract", "invalid_json"},
	},
	"hub_connection_attempts": {
		"state": {"connected", "unreachable", "timeout", "tls_error", "authentication_failed", "unsupported_contract", "invalid_json"},
	},
	"service_identifier_mappings": {
		"identifier_kind": {"usage_cost", "usage_limit"},
	},
	"limit_definitions": {
		"billing_confirmation": {"not_applicable", "unconfirmed", "confirmed"},
	},
	"identification_candidates": {
		"state": {"unconfirmed", "confirmed", "rejected"},
	},
	"limit_label_change_candidates": {
		"state": {"unconfirmed", "confirmed_same_limit", "confirmed_different_limit", "rejected"},
	},
	"collection_attempts": {
		"trigger": {"scheduled", "manual"},
		"state":   {"started", "succeeded", "failed", "skipped"},
	},
	"raw_snapshots": {
		"response_kind": {"health", "stats"},
	},
	"usage_cost_observations": {
		"dedupe_state": {"canonical", "conflict"},
	},
	"usage_limit_observations": {
		"dedupe_state": {"canonical", "conflict"},
	},
	"usage_analysis_observations": {
		"dedupe_state": {"canonical", "conflict"},
	},
	"hub_account_candidates": {
		"state": {"unconfirmed", "associated", "rejected", "archived_reconfirmation"},
	},
	"usage_cost_source_completeness": {
		"state": {"unconfirmed", "confirmed"},
	},
	"calculation_boundaries": {
		"boundary_kind": {"reset", "plan_history", "association", "completeness", "hub_switch", "api_contract", "unexplained_decrease"},
	},
	"calculation_intervals": {
		"state": {"estimable", "excluded"},
	},
	"matched_observations": {
		"observation_role": {"limit", "cost"},
	},
	"estimation_results": {
		"status": {"insufficient_observations", "unidentifiable", "estimated", "model_mismatch", "not_applicable", "uncomputed"},
	},
	"estimation_result_evidence": {
		"evidence_kind": {"point", "matched_observation", "snapshot", "association", "completeness", "plan_history"},
	},
}

func (l *Lifecycle) ValidateRestoreDatabase(ctx context.Context, path string, manifest domain.BackupManifest) error {
	return l.validateRestoreDatabase(ctx, path, manifest, true)
}

func (l *Lifecycle) validateRestoreDatabase(ctx context.Context, path string, manifest domain.BackupManifest, rejectOperational bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := manifest.Validate(); err != nil {
		return restoreError(domain.RestoreValidationManifestJSON, err)
	}
	if manifest.SchemaVersion != CurrentSchemaVersion {
		return restoreError(domain.RestoreValidationSchemaVersion, fmt.Errorf("restore schema version %d does not match current schema version %d", manifest.SchemaVersion, CurrentSchemaVersion))
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return restoreError(domain.RestoreValidationIntegrity, errors.New("resolve restore database path"))
	}
	if rejectOperational {
		if err := l.rejectOperationalDatabase(absolutePath); err != nil {
			return restoreError(domain.RestoreValidationIntegrity, err)
		}
	}
	if err := validateRestoreDatabaseFile(ctx, absolutePath, manifest); err != nil {
		return err
	}
	if err := requireNoSidecars(absolutePath); err != nil {
		return restoreError(domain.RestoreValidationIntegrity, err)
	}
	database, err := sql.Open("sqlite", sqliteReadOnlyDSN(absolutePath))
	if err != nil {
		return restoreError(domain.RestoreValidationIntegrity, errors.New("open restore database read-only"))
	}
	database.SetMaxOpenConns(1)
	defer func() { _ = database.Close() }()
	if err := database.PingContext(ctx); err != nil {
		return restoreError(domain.RestoreValidationIntegrity, fmt.Errorf("open restore database read-only: %w", err))
	}
	deferredIntegrityErr, err := validateRestoreIntegrity(ctx, database)
	if err != nil {
		return err
	}
	if err := validateRestoreSchemaVersion(ctx, database, manifest.SchemaVersion); err != nil {
		return err
	}
	if err := validateRequiredSchema(ctx, database, filepath.Dir(absolutePath)); err != nil {
		return err
	}
	if err := validateRestoreEnums(ctx, database); err != nil {
		return err
	}
	if err := validateRestoreDatetimes(ctx, database); err != nil {
		return err
	}
	if err := validateRestoreForeignKeys(ctx, database); err != nil {
		return err
	}
	if err := validateRestoreIntervals(ctx, database); err != nil {
		return err
	}
	if err := validateRestoreSecrets(ctx, database); err != nil {
		return err
	}
	if deferredIntegrityErr != nil {
		return restoreError(domain.RestoreValidationIntegrity, deferredIntegrityErr)
	}
	if err := validateRestoreRecalculation(ctx, database, absolutePath); err != nil {
		return err
	}
	return nil
}

func (l *Lifecycle) RunIsolatedRestoreTrial(ctx context.Context, sourcePath, trialDirectory string, manifest domain.BackupManifest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	absoluteDirectory, err := filepath.Abs(trialDirectory)
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, errors.New("resolve isolated restore directory"))
	}
	entries, err := os.ReadDir(absoluteDirectory)
	if err != nil || len(entries) != 0 {
		return restoreError(domain.RestoreValidationComparison, errors.New("isolated restore directory must exist and be empty"))
	}
	if err := rejectRestoreReparsePath(absoluteDirectory); err != nil {
		return restoreError(domain.RestoreValidationComparison, err)
	}
	absoluteSource, err := filepath.Abs(sourcePath)
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, errors.New("resolve validated restore database"))
	}
	if err := l.rejectOperationalDatabase(absoluteSource); err != nil {
		return restoreError(domain.RestoreValidationComparison, err)
	}
	if err := l.ValidateRestoreDatabase(ctx, absoluteSource, manifest); err != nil {
		return err
	}
	info, err := os.Stat(absoluteSource)
	if err != nil || info.Size() <= 0 {
		return restoreError(domain.RestoreValidationComparison, errors.New("validated restore database is unavailable"))
	}
	available, err := restoreFreeSpace(absoluteDirectory)
	if err != nil {
		return restoreError(domain.RestoreValidationFreeSpace, errors.New("inspect isolated restore free space"))
	}
	if uint64(info.Size()) > available {
		return restoreError(domain.RestoreValidationFreeSpace, errors.New("insufficient space for isolated restore database"))
	}
	targetPath := filepath.Join(absoluteDirectory, "data.sqlite3")
	if err := copyDatabaseForRestoreTrial(ctx, absoluteSource, targetPath); err != nil {
		return err
	}
	targetManifest, err := manifestForRestoreDatabase(ctx, targetPath, manifest)
	if err != nil {
		return err
	}
	if err := l.ValidateRestoreDatabase(ctx, targetPath, targetManifest); err != nil {
		return err
	}
	sourceSnapshot, err := logicalSnapshot(ctx, absoluteSource)
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, fmt.Errorf("snapshot validated restore database: %w", err))
	}
	targetSnapshot, err := logicalSnapshot(ctx, targetPath)
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, fmt.Errorf("snapshot isolated restore database: %w", err))
	}
	if !reflect.DeepEqual(sourceSnapshot, targetSnapshot) {
		return restoreError(domain.RestoreValidationComparison, errors.New("isolated restore logical contents differ from the validated artifact"))
	}
	return nil
}

func manifestForRestoreDatabase(ctx context.Context, path string, template domain.BackupManifest) (domain.BackupManifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return domain.BackupManifest{}, restoreError(domain.RestoreValidationIntegrity, errors.New("open isolated restore database"))
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return domain.BackupManifest{}, restoreError(domain.RestoreValidationIntegrity, errors.New("inspect isolated restore database"))
	}
	hasher := sha256.New()
	buffer := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return domain.BackupManifest{}, err
		}
		read, readErr := file.Read(buffer)
		if read > 0 {
			_, _ = hasher.Write(buffer[:read])
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return domain.BackupManifest{}, restoreError(domain.RestoreValidationIntegrity, errors.New("read isolated restore database"))
		}
	}
	template.Database.SizeBytes = info.Size()
	template.Database.SHA256 = hex.EncodeToString(hasher.Sum(nil))
	return template, nil
}

func validateRestoreDatabaseFile(ctx context.Context, path string, manifest domain.BackupManifest) error {
	file, err := os.Open(path)
	if err != nil {
		return restoreError(domain.RestoreValidationIntegrity, errors.New("open restore database file"))
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return restoreError(domain.RestoreValidationIntegrity, errors.New("inspect restore database file"))
	}
	if info.Size() != manifest.Database.SizeBytes {
		return restoreError(domain.RestoreValidationDeclaredSize, errors.New("restore database file size does not match manifest"))
	}
	hasher := sha256.New()
	buffer := make([]byte, 128*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		read, readErr := file.Read(buffer)
		if read > 0 {
			_, _ = hasher.Write(buffer[:read])
		}
		if errors.Is(readErr, os.ErrClosed) {
			return restoreError(domain.RestoreValidationIntegrity, errors.New("read restore database file"))
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return restoreError(domain.RestoreValidationIntegrity, errors.New("read restore database file"))
		}
	}
	if hex.EncodeToString(hasher.Sum(nil)) != manifest.Database.SHA256 {
		return restoreError(domain.RestoreValidationDatabaseSHA, errors.New("restore database file SHA-256 does not match manifest"))
	}
	return nil
}

func (l *Lifecycle) rejectOperationalDatabase(candidate string) error {
	l.mu.Lock()
	operationalPath := l.databasePath
	l.mu.Unlock()
	if operationalPath == "" {
		return nil
	}
	operational, err := filepath.Abs(operationalPath)
	if err != nil {
		return errors.New("resolve operational database path")
	}
	if filepath.Clean(candidate) == filepath.Clean(operational) {
		return errors.New("restore validation cannot use the operational database")
	}
	candidateInfo, candidateErr := os.Stat(candidate)
	operationalInfo, operationalErr := os.Stat(operational)
	if candidateErr == nil && operationalErr == nil && os.SameFile(candidateInfo, operationalInfo) {
		return errors.New("restore validation database aliases the operational database")
	}
	return nil
}

func requireNoSidecars(path string) error {
	for _, sidecar := range []string{path + "-wal", path + "-shm"} {
		if _, err := os.Stat(sidecar); err == nil {
			return errors.New("restore database contains a SQLite sidecar")
		} else if !os.IsNotExist(err) {
			return errors.New("inspect restore database sidecar")
		}
	}
	return nil
}

func sqliteReadOnlyDSN(path string) string {
	urlPath := filepath.ToSlash(path)
	if filepath.VolumeName(path) != "" {
		urlPath = "/" + urlPath
	}
	query := url.Values{}
	query.Set("mode", "ro")
	query.Set("immutable", "1")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(ON)")
	query.Add("_pragma", "query_only(ON)")
	return (&url.URL{Scheme: "file", Path: urlPath, RawQuery: query.Encode()}).String()
}

func validateRestoreIntegrity(ctx context.Context, database *sql.DB) (error, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA integrity_check`)
	if err != nil {
		return nil, restoreError(domain.RestoreValidationIntegrity, fmt.Errorf("run restore integrity_check: %w", err))
	}
	defer func() { _ = rows.Close() }()
	var failures []string
	for rows.Next() {
		var result string
		if err := rows.Scan(&result); err != nil {
			return nil, restoreError(domain.RestoreValidationIntegrity, errors.New("read restore integrity_check"))
		}
		if result != "ok" {
			failures = append(failures, result)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, restoreError(domain.RestoreValidationIntegrity, errors.New("read restore integrity_check"))
	}
	if len(failures) == 0 {
		return nil, nil
	}
	failure := errors.New("restore database failed integrity_check")
	for _, message := range failures {
		if !strings.Contains(message, "CHECK constraint failed") {
			return nil, restoreError(domain.RestoreValidationIntegrity, failure)
		}
	}
	return failure, nil
}

func validateRestoreSchemaVersion(ctx context.Context, database *sql.DB, expected int64) error {
	var actual int64
	if err := database.QueryRowContext(ctx, `SELECT schema_version FROM schema_metadata WHERE singleton = 1`).Scan(&actual); err != nil {
		return restoreError(domain.RestoreValidationRequiredSchema, errors.New("restore database has no schema metadata"))
	}
	if actual != expected {
		return restoreError(domain.RestoreValidationSchemaVersion, fmt.Errorf("restore database schema version %d does not match manifest schema version %d", actual, expected))
	}
	return nil
}

func validateRequiredSchema(ctx context.Context, database *sql.DB, temporaryRoot string) error {
	expected, err := referenceSchema(ctx, temporaryRoot)
	if err != nil {
		return restoreError(domain.RestoreValidationRequiredSchema, fmt.Errorf("build current schema contract: %w", err))
	}
	actual, err := schemaShape(ctx, database)
	if err != nil {
		return restoreError(domain.RestoreValidationRequiredSchema, err)
	}
	for table, expectedColumns := range expected {
		actualColumns, exists := actual[table]
		if !exists {
			return restoreError(domain.RestoreValidationRequiredSchema, fmt.Errorf("restore database is missing required table %q", table))
		}
		byName := make(map[string]schemaColumn, len(actualColumns))
		for _, column := range actualColumns {
			byName[column.Name] = column
		}
		for _, expectedColumn := range expectedColumns {
			actualColumn, exists := byName[expectedColumn.Name]
			if !exists {
				return restoreError(domain.RestoreValidationRequiredSchema, fmt.Errorf("restore database table %q is missing required column %q", table, expectedColumn.Name))
			}
			if actualColumn.Type != expectedColumn.Type || actualColumn.NotNull != expectedColumn.NotNull || actualColumn.Primary != expectedColumn.Primary {
				return restoreError(domain.RestoreValidationRequiredSchema, fmt.Errorf("restore database column %q.%q has an incompatible definition", table, expectedColumn.Name))
			}
		}
	}
	return nil
}

func referenceSchema(ctx context.Context, temporaryRoot string) (map[string][]schemaColumn, error) {
	file, err := os.CreateTemp(temporaryRoot, "restore-schema-reference-*.sqlite3")
	if err != nil {
		return nil, err
	}
	path := file.Name()
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	defer func() {
		_ = os.Remove(path)
		_ = os.Remove(path + "-wal")
		_ = os.Remove(path + "-shm")
	}()
	reference, err := sql.Open("sqlite", sqliteReadWriteDSN(path))
	if err != nil {
		return nil, err
	}
	reference.SetMaxOpenConns(1)
	if err := reference.PingContext(ctx); err != nil {
		_ = reference.Close()
		return nil, err
	}
	if err := migrate(ctx, reference); err != nil {
		_ = reference.Close()
		return nil, err
	}
	shape, shapeErr := schemaShape(ctx, reference)
	closeErr := reference.Close()
	if shapeErr != nil {
		return nil, shapeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return shape, nil
}

func schemaShape(ctx context.Context, database *sql.DB) (map[string][]schemaColumn, error) {
	tables, err := userTables(ctx, database)
	if err != nil {
		return nil, err
	}
	result := make(map[string][]schemaColumn, len(tables))
	for _, table := range tables {
		columns, err := restoreTableShape(ctx, database, table)
		if err != nil {
			return nil, err
		}
		result[table] = columns
	}
	return result, nil
}

func restoreTableShape(ctx context.Context, database *sql.DB, table string) ([]schemaColumn, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA table_info(`+quoteIdentifier(table)+`)`)
	if err != nil {
		return nil, fmt.Errorf("inspect restore table %q: %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	var columns []schemaColumn
	for rows.Next() {
		var position int
		var column schemaColumn
		var defaultValue any
		if err := rows.Scan(&position, &column.Name, &column.Type, &column.NotNull, &defaultValue, &column.Primary); err != nil {
			return nil, fmt.Errorf("read restore table %q columns: %w", table, err)
		}
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

func userTables(ctx context.Context, database *sql.DB) ([]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	return tables, rows.Err()
}

func validateRestoreEnums(ctx context.Context, database *sql.DB) error {
	for table, columns := range restoreEnumContracts {
		for column, allowed := range columns {
			placeholders := strings.TrimSuffix(strings.Repeat("?,", len(allowed)), ",")
			query := `SELECT 1 FROM ` + quoteIdentifier(table) + ` WHERE ` + quoteIdentifier(column) + ` NOT IN (` + placeholders + `) LIMIT 1`
			arguments := make([]any, len(allowed))
			for index, value := range allowed {
				arguments[index] = value
			}
			var invalid int
			err := database.QueryRowContext(ctx, query, arguments...).Scan(&invalid)
			if err == nil {
				return restoreError(domain.RestoreValidationEnum, fmt.Errorf("restore database contains an invalid %s.%s value", table, column))
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return restoreError(domain.RestoreValidationEnum, fmt.Errorf("validate restore enum %s.%s: %w", table, column, err))
			}
		}
	}
	return nil
}

func validateRestoreDatetimes(ctx context.Context, database *sql.DB) error {
	shape, err := schemaShape(ctx, database)
	if err != nil {
		return restoreError(domain.RestoreValidationDatetime, err)
	}
	for table, columns := range shape {
		for _, column := range columns {
			if !isRestoreDatetimeColumn(column.Name) {
				continue
			}
			query := `SELECT ` + quoteIdentifier(column.Name) + ` FROM ` + quoteIdentifier(table) + ` WHERE ` + quoteIdentifier(column.Name) + ` IS NOT NULL`
			if err := validateRestoreDatetimeColumn(ctx, database, query, table, column.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateRestoreDatetimeColumn(ctx context.Context, database *sql.DB, query, table, column string) error {
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return restoreError(domain.RestoreValidationDatetime, fmt.Errorf("read restore datetime %s.%s: %w", table, column, err))
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var value any
		if err := rows.Scan(&value); err != nil {
			return restoreError(domain.RestoreValidationDatetime, fmt.Errorf("read restore datetime %s.%s", table, column))
		}
		text, ok := value.(string)
		if !ok || !validRestoreUTC(text) {
			return restoreError(domain.RestoreValidationDatetime, fmt.Errorf("restore database contains an invalid UTC datetime in %s.%s", table, column))
		}
	}
	if err := rows.Err(); err != nil {
		return restoreError(domain.RestoreValidationDatetime, err)
	}
	return nil
}

func isRestoreDatetimeColumn(name string) bool {
	return strings.HasSuffix(name, "_at") || strings.HasSuffix(name, "_from") || strings.HasSuffix(name, "_to") ||
		name == "interval_start" || name == "interval_end"
}

func validRestoreUTC(value string) bool {
	if !strings.HasSuffix(value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC
}

func validateRestoreForeignKeys(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return restoreError(domain.RestoreValidationForeignKey, fmt.Errorf("run restore foreign_key_check: %w", err))
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() {
		return restoreError(domain.RestoreValidationForeignKey, errors.New("restore database contains a foreign key violation"))
	}
	if err := rows.Err(); err != nil {
		return restoreError(domain.RestoreValidationForeignKey, err)
	}
	return nil
}

func validateRestoreIntervals(ctx context.Context, database *sql.DB) error {
	for _, contract := range restoreIntervalContracts {
		query := `SELECT 1 FROM ` + quoteIdentifier(contract.Table) + ` WHERE valid_to IS NOT NULL AND valid_from >= valid_to LIMIT 1`
		var found int
		err := database.QueryRowContext(ctx, query).Scan(&found)
		if err == nil {
			return restoreError(domain.RestoreValidationInterval, fmt.Errorf("restore database contains a reversed interval in %s", contract.Table))
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return restoreError(domain.RestoreValidationInterval, err)
		}
		groups := make([]string, 0, len(contract.GroupColumns))
		for _, column := range contract.GroupColumns {
			groups = append(groups, `a.`+quoteIdentifier(column)+` = b.`+quoteIdentifier(column))
		}
		query = `SELECT 1 FROM ` + quoteIdentifier(contract.Table) + ` a JOIN ` + quoteIdentifier(contract.Table) + ` b ON a.` + quoteIdentifier(contract.ID) + ` < b.` + quoteIdentifier(contract.ID) + ` AND ` + strings.Join(groups, ` AND `) + ` WHERE (a.valid_to IS NULL OR b.valid_from < a.valid_to) AND (b.valid_to IS NULL OR a.valid_from < b.valid_to) LIMIT 1`
		err = database.QueryRowContext(ctx, query).Scan(&found)
		if err == nil {
			return restoreError(domain.RestoreValidationInterval, fmt.Errorf("restore database contains overlapping intervals in %s", contract.Table))
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return restoreError(domain.RestoreValidationInterval, fmt.Errorf("validate restore intervals in %s: %w", contract.Table, err))
		}
	}
	return nil
}

func validateRestoreSecrets(ctx context.Context, database *sql.DB) error {
	if err := validateRestoreSchemaSecrets(ctx, database); err != nil {
		return err
	}
	if err := validateRawSnapshots(ctx, database); err != nil {
		return restoreError(domain.RestoreValidationSecret, err)
	}
	return nil
}

func validateRestoreSchemaSecrets(ctx context.Context, database *sql.DB) error {
	rows, err := database.QueryContext(ctx, `SELECT name, COALESCE(sql, '') FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')`)
	if err != nil {
		return restoreError(domain.RestoreValidationSecret, errors.New("inspect restore database for secret fields"))
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name, definition string
		if err := rows.Scan(&name, &definition); err != nil {
			return restoreError(domain.RestoreValidationSecret, errors.New("read restore schema for secret fields"))
		}
		if domain.IsRawSecretField(name) || containsForbiddenIdentifier(definition) {
			return restoreError(domain.RestoreValidationSecret, errors.New("restore database schema contains a prohibited secret field"))
		}
	}
	if err := rows.Err(); err != nil {
		return restoreError(domain.RestoreValidationSecret, err)
	}
	return nil
}

func validateRestoreRecalculation(ctx context.Context, database *sql.DB, path string) error {
	reader := &Lifecycle{database: database, databasePath: path}
	resultKeys, err := queryDatabaseStringColumn(ctx, database, `SELECT result_set_key FROM estimation_results ORDER BY result_set_key`)
	if err != nil {
		return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("read restore estimation results: %w", err))
	}
	if len(resultKeys) == 0 {
		intervalIDs, err := queryDatabaseStringColumn(ctx, database, `SELECT calculation_interval_id FROM calculation_intervals ORDER BY calculation_interval_id`)
		if err != nil {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("read restore calculation intervals: %w", err))
		}
		for _, intervalID := range intervalIDs {
			input, err := reader.ListEstimationInput(ctx, intervalID)
			if err != nil {
				return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("read restore estimation input: %w", err))
			}
			if _, err := domain.EstimateFromPoints(input); err != nil {
				return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("recalculate restore estimation input: %w", err))
			}
		}
		return nil
	}
	for _, resultKey := range resultKeys {
		stored, err := reader.GetEstimationResult(ctx, resultKey)
		if err != nil {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("read restore estimation result: %w", err))
		}
		if len(stored.CalculationIntervalIDs) == 0 {
			return restoreError(domain.RestoreValidationRecalculation, errors.New("restore estimation result has no calculation interval"))
		}
		input, err := reader.ListEstimationInput(ctx, stored.CalculationIntervalIDs[0])
		if err != nil {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("read restore estimation input: %w", err))
		}
		recalculated, err := domain.EstimateFromPoints(input)
		if err != nil {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("recalculate restore estimation result: %w", err))
		}
		if stored.Status != recalculated.Status || !reflect.DeepEqual(stored.Reasons, recalculated.Reasons) ||
			!equalFloats(stored.Limits, recalculated.Limits) || stored.Rank != recalculated.Rank ||
			stored.CalculationLogicVersion != recalculated.CalculationLogicVersion ||
			stored.MaxTimeDelta != recalculated.MaxTimeDelta || stored.Rows != len(input.Points) ||
			stored.DifferenceRowCount != len(recalculated.DifferenceRows) {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("restore estimation result %q is not reproducible", stored.ID))
		}
		fingerprint, err := domain.ComputeInputFingerprint(input.Points, recalculated.DifferenceRows, stored.Evidence, recalculated.SeriesMultipliers, recalculated.PlanLimitRuleIDs, stored.MatchingRuleVersion, recalculated.CalculationLogicVersion, recalculated.PlanLimitRules...)
		if err != nil || fingerprint != stored.InputFingerprint {
			return restoreError(domain.RestoreValidationRecalculation, fmt.Errorf("restore estimation result %q input fingerprint is not reproducible", stored.ID))
		}
	}
	return nil
}

func queryDatabaseStringColumn(ctx context.Context, database *sql.DB, query string) ([]string, error) {
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

func equalFloats(left, right []float64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if math.Float64bits(left[index]) != math.Float64bits(right[index]) {
			return false
		}
	}
	return true
}

func copyDatabaseForRestoreTrial(ctx context.Context, sourcePath, targetPath string) error {
	source, err := sql.Open("sqlite", sqliteReadOnlyDSN(sourcePath))
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, errors.New("open validated database for isolated restore"))
	}
	source.SetMaxOpenConns(1)
	defer func() { _ = source.Close() }()
	connection, err := source.Conn(ctx)
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, errors.New("acquire isolated restore source connection"))
	}
	defer func() { _ = connection.Close() }()
	err = connection.Raw(func(raw any) error {
		backuper, ok := raw.(interface {
			NewBackup(string) (*modernsqlite.Backup, error)
		})
		if !ok {
			return errors.New("SQLite driver does not support isolated restore")
		}
		backup, err := backuper.NewBackup(targetPath)
		if err != nil {
			return err
		}
		for {
			if err := ctx.Err(); err != nil {
				_ = backup.Finish()
				return err
			}
			more, err := backup.Step(128)
			if err != nil {
				_ = backup.Finish()
				return err
			}
			if !more {
				break
			}
		}
		target, err := backup.Commit()
		if err != nil {
			return err
		}
		return target.Close()
	})
	if err != nil {
		return restoreError(domain.RestoreValidationComparison, fmt.Errorf("restore database into isolated environment: %w", err))
	}
	return nil
}

type logicalTableSnapshot struct {
	Rows int64
	Hash [sha256.Size]byte
}

func logicalSnapshot(ctx context.Context, path string) (map[string]logicalTableSnapshot, error) {
	database, err := sql.Open("sqlite", sqliteReadOnlyDSN(path))
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	defer func() { _ = database.Close() }()
	return logicalSnapshotDatabase(ctx, database, "")
}

func logicalSnapshotDatabase(ctx context.Context, database *sql.DB, excludedAuditID string) (map[string]logicalTableSnapshot, error) {
	tables, err := userTables(ctx, database)
	if err != nil {
		return nil, err
	}
	result := make(map[string]logicalTableSnapshot, len(tables))
	for _, table := range tables {
		columns, primary, err := snapshotColumns(ctx, database, table)
		if err != nil {
			return nil, err
		}
		order := primary
		if len(order) == 0 {
			order = columns
		}
		quotedColumns := make([]string, len(columns))
		for index, column := range columns {
			quotedColumns[index] = quoteIdentifier(column)
		}
		quotedOrder := make([]string, len(order))
		for index, column := range order {
			quotedOrder[index] = quoteIdentifier(column)
		}
		query := `SELECT ` + strings.Join(quotedColumns, `, `) + ` FROM ` + quoteIdentifier(table)
		var arguments []any
		if table == "configuration_audits" && excludedAuditID != "" {
			query += ` WHERE audit_id <> ?`
			arguments = append(arguments, excludedAuditID)
		}
		query += ` ORDER BY ` + strings.Join(quotedOrder, `, `)
		snapshot, err := hashLogicalQuery(ctx, database, query, len(columns), arguments...)
		if err != nil {
			return nil, err
		}
		result[table] = snapshot
	}
	return result, nil
}

func hashLogicalQuery(ctx context.Context, database *sql.DB, query string, columnCount int, arguments ...any) (logicalTableSnapshot, error) {
	rows, err := database.QueryContext(ctx, query, arguments...)
	if err != nil {
		return logicalTableSnapshot{}, err
	}
	defer func() { _ = rows.Close() }()
	hasher := sha256.New()
	var count int64
	for rows.Next() {
		values := make([]any, columnCount)
		pointers := make([]any, columnCount)
		for index := range values {
			pointers[index] = &values[index]
		}
		if err := rows.Scan(pointers...); err != nil {
			return logicalTableSnapshot{}, err
		}
		for _, value := range values {
			if err := hashLogicalValue(hasher, value); err != nil {
				return logicalTableSnapshot{}, err
			}
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return logicalTableSnapshot{}, err
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return logicalTableSnapshot{Rows: count, Hash: digest}, nil
}

func snapshotColumns(ctx context.Context, database *sql.DB, table string) ([]string, []string, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA table_info(`+quoteIdentifier(table)+`)`)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
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

func hashLogicalValue(hasher hash.Hash, value any) error {
	var tag byte
	var data []byte
	switch typed := value.(type) {
	case nil:
		tag = 0
	case int64:
		tag = 1
		data = make([]byte, 8)
		binary.LittleEndian.PutUint64(data, uint64(typed))
	case float64:
		tag = 2
		data = make([]byte, 8)
		binary.LittleEndian.PutUint64(data, math.Float64bits(typed))
	case string:
		tag = 3
		data = []byte(typed)
	case []byte:
		tag = 4
		data = typed
	case time.Time:
		tag = 5
		data = []byte(typed.UTC().Format(time.RFC3339Nano))
	default:
		return fmt.Errorf("unsupported SQLite logical value type %T", value)
	}
	if _, err := hasher.Write([]byte{tag}); err != nil {
		return err
	}
	length := make([]byte, 8)
	binary.LittleEndian.PutUint64(length, uint64(len(data)))
	if _, err := hasher.Write(length); err != nil {
		return err
	}
	_, err := hasher.Write(data)
	return err
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func restoreError(code domain.RestoreValidationCode, err error) error {
	var validationErr *domain.RestoreValidationError
	if errors.As(err, &validationErr) {
		return err
	}
	return &domain.RestoreValidationError{Code: code, Err: err}
}
