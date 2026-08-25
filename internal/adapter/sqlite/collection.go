package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type CollectionAttempt struct {
	AttemptID                string
	HubID                    string
	Trigger                  string
	State                    string
	StartedAt                time.Time
	CompletedAt              *time.Time
	AnalyticsIntervalSeconds int64
	HealthHTTPStatus         *int
	StatsHTTPStatus          *int
	APIContract              string
	HealthSnapshotID         string
	StatsSnapshotID          string
	FailureCode              string
	FailureDetail            string
	NormalizationErrorPath   string
}

type RawSnapshot struct {
	SnapshotID          string
	AttemptID           string
	HubID               string
	ResponseKind        string
	ReceivedStartedAt   time.Time
	ReceivedCompletedAt time.Time
	HTTPStatus          int
	APIContract         string
	Body                []byte
}

type CostObservation struct {
	ObservationID             string
	SnapshotID                string
	HubID                     string
	DeviceID                  string
	RawServiceIdentifier      string
	UsageUpdatedAt            time.Time
	CostUSDText               string
	SyncUploadIntervalMS      *int64
	AnalyticsIntervalSeconds  int64
	SourceTimezone            string
	SourceLocalDate           string
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	JSONPath                  string
	DedupeState               string
	DedupeKey                 string
	ValueFingerprint          string
}

type LimitObservation struct {
	ObservationID             string
	SnapshotID                string
	HubID                     string
	DeviceID                  string
	RawServiceIdentifier      string
	AccountKey                string
	ProviderUpdatedAt         time.Time
	WindowKey                 string
	NormalizedKind            string
	NormalizedMetric          string
	NormalizedLabel           string
	PlanLabel                 string
	UsedPercent               *float64
	ResetsAt                  *time.Time
	SyncUploadIntervalMS      *int64
	LimitsRefreshMS           *int64
	AnalyticsIntervalSeconds  int64
	SourceTimezone            string
	SourceLocalDate           string
	NormalizationGeneration   int64
	NormalizationRuleVersion  string
	NormalizationLogicVersion string
	JSONPath                  string
	DedupeState               string
	DedupeKey                 string
	ValueFingerprint          string
	WindowKeyConflict         bool
}

func (l *Lifecycle) CreateCollectionAttempt(ctx context.Context, attempt CollectionAttempt) error {
	if attempt.AttemptID == "" || attempt.HubID == "" || attempt.Trigger == "" || attempt.State == "" || attempt.StartedAt.IsZero() || attempt.AnalyticsIntervalSeconds <= 0 {
		return errors.New("collection attempt has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	_, err = database.ExecContext(ctx, `
		INSERT INTO collection_attempts
			(attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds)
		VALUES (?, ?, ?, ?, ?, ?)`, attempt.AttemptID, attempt.HubID, attempt.Trigger,
		attempt.State, utcText(attempt.StartedAt), attempt.AnalyticsIntervalSeconds)
	if err != nil {
		return fmt.Errorf("insert collection attempt: %w", err)
	}
	return nil
}

func (l *Lifecycle) FinishCollectionAttempt(ctx context.Context, attempt CollectionAttempt) error {
	if attempt.AttemptID == "" || attempt.State == "" {
		return errors.New("collection attempt result has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	var completed any
	if attempt.CompletedAt != nil {
		completed = utcText(*attempt.CompletedAt)
	}
	result, err := database.ExecContext(ctx, `
		UPDATE collection_attempts SET state = ?, completed_at = ?, health_http_status = ?, stats_http_status = ?,
			api_contract = ?, health_snapshot_id = ?, stats_snapshot_id = ?, failure_code = ?, failure_detail = ?, normalization_error_path = ?
		WHERE attempt_id = ?`, attempt.State, completed, nullableInt(attempt.HealthHTTPStatus), nullableInt(attempt.StatsHTTPStatus),
		nullText(attempt.APIContract), nullText(attempt.HealthSnapshotID), nullText(attempt.StatsSnapshotID),
		nullText(attempt.FailureCode), nullText(attempt.FailureDetail), nullText(attempt.NormalizationErrorPath), attempt.AttemptID)
	if err != nil {
		return fmt.Errorf("finish collection attempt: %w", err)
	}
	return requireOneCollectionAttempt(result)
}

func (l *Lifecycle) SaveRawSnapshot(ctx context.Context, snapshot RawSnapshot) error {
	return l.SaveRawSnapshots(ctx, []RawSnapshot{snapshot})
}

func (l *Lifecycle) SaveRawSnapshots(ctx context.Context, snapshots []RawSnapshot) error {
	if len(snapshots) == 0 {
		return nil
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin raw snapshot: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, snapshot := range snapshots {
		if snapshot.SnapshotID == "" || snapshot.AttemptID == "" || snapshot.HubID == "" || snapshot.ResponseKind == "" || snapshot.ReceivedStartedAt.IsZero() || snapshot.ReceivedCompletedAt.IsZero() || snapshot.HTTPStatus <= 0 || snapshot.Body == nil {
			return errors.New("raw snapshot has an empty required field")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO raw_snapshots
				(snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, api_contract, body)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, snapshot.SnapshotID, snapshot.AttemptID, snapshot.HubID, snapshot.ResponseKind,
			utcText(snapshot.ReceivedStartedAt), utcText(snapshot.ReceivedCompletedAt), snapshot.HTTPStatus,
			nullText(snapshot.APIContract), append([]byte(nil), snapshot.Body...)); err != nil {
			return fmt.Errorf("insert raw snapshot: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit raw snapshots: %w", err)
	}
	return nil
}

func (l *Lifecycle) InsertCostObservations(ctx context.Context, observations []CostObservation) error {
	return l.InsertObservations(ctx, observations, nil)
}

func (l *Lifecycle) insertCostObservationsTx(ctx context.Context, tx *sql.Tx, observations []CostObservation) error {
	if len(observations) == 0 {
		return nil
	}
	for _, observation := range observations {
		if err := validateCostObservation(observation); err != nil {
			return err
		}
		state, err := costDedupeState(ctx, tx, observation)
		if err != nil {
			return err
		}
		if state == "conflict" {
			if _, err := tx.ExecContext(ctx, `UPDATE usage_cost_observations SET dedupe_state = 'conflict' WHERE hub_id = ? AND dedupe_key = ? AND value_fingerprint <> ?`, observation.HubID, observation.DedupeKey, observation.ValueFingerprint); err != nil {
				return fmt.Errorf("mark cost conflict: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO usage_cost_observations
				(observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text,
				sync_upload_interval_ms, analytics_interval_seconds, source_timezone, source_local_date,
				normalization_generation, normalization_rule_version, normalization_logic_version, json_path,
				dedupe_state, dedupe_key, value_fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, observation.ObservationID, observation.SnapshotID,
			observation.HubID, observation.DeviceID, observation.RawServiceIdentifier, utcText(observation.UsageUpdatedAt),
			observation.CostUSDText, nullableInt64(observation.SyncUploadIntervalMS), observation.AnalyticsIntervalSeconds,
			nullText(observation.SourceTimezone), nullText(observation.SourceLocalDate), observation.NormalizationGeneration,
			observation.NormalizationRuleVersion, observation.NormalizationLogicVersion, observation.JSONPath, state,
			observation.DedupeKey, observation.ValueFingerprint); err != nil {
			return fmt.Errorf("insert cost observation: %w", err)
		}
	}
	return nil
}

func (l *Lifecycle) InsertLimitObservations(ctx context.Context, observations []LimitObservation) error {
	return l.InsertObservations(ctx, nil, observations)
}

func (l *Lifecycle) insertLimitObservationsTx(ctx context.Context, tx *sql.Tx, observations []LimitObservation) error {
	if len(observations) == 0 {
		return nil
	}
	for _, observation := range observations {
		if err := validateLimitObservation(observation); err != nil {
			return err
		}
		state, err := limitDedupeState(ctx, tx, observation)
		if err != nil {
			return err
		}
		if state == "conflict" || observation.WindowKeyConflict {
			if _, err := tx.ExecContext(ctx, `UPDATE usage_limit_observations SET dedupe_state = 'conflict' WHERE hub_id = ? AND dedupe_key = ?`, observation.HubID, observation.DedupeKey); err != nil {
				return fmt.Errorf("mark limit conflict: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO usage_limit_observations
				(observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at,
				window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at,
				sync_upload_interval_ms, limits_refresh_ms, analytics_interval_seconds, source_timezone, source_local_date,
				normalization_generation, normalization_rule_version, normalization_logic_version, json_path,
				dedupe_state, dedupe_key, value_fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			observation.ObservationID, observation.SnapshotID, observation.HubID, observation.DeviceID,
			observation.RawServiceIdentifier, observation.AccountKey, utcText(observation.ProviderUpdatedAt), observation.WindowKey,
			observation.NormalizedKind, observation.NormalizedMetric, observation.NormalizedLabel, observation.PlanLabel, nullableFloat64(observation.UsedPercent),
			nullableTime(observation.ResetsAt), nullableInt64(observation.SyncUploadIntervalMS), nullableInt64(observation.LimitsRefreshMS),
			observation.AnalyticsIntervalSeconds, nullText(observation.SourceTimezone), nullText(observation.SourceLocalDate),
			observation.NormalizationGeneration, observation.NormalizationRuleVersion, observation.NormalizationLogicVersion,
			observation.JSONPath, state, observation.DedupeKey, observation.ValueFingerprint); err != nil {
			return fmt.Errorf("insert limit observation: %w", err)
		}
	}
	return nil
}

// InsertObservations commits cost and limit observations atomically. If either
// side fails, no normalized row is committed and the raw snapshot remains the
// evidence of the attempted collection.
func (l *Lifecycle) InsertObservations(ctx context.Context, costs []CostObservation, limits []LimitObservation) error {
	if len(costs) == 0 && len(limits) == 0 {
		return nil
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin observations: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := l.insertCostObservationsTx(ctx, tx, costs); err != nil {
		return err
	}
	if err := l.insertLimitObservationsTx(ctx, tx, limits); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit observations: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListCollectionAttempts(ctx context.Context, hubID string) ([]CollectionAttempt, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT attempt_id, hub_id, trigger, state, started_at, completed_at,
		analytics_interval_seconds, health_http_status, stats_http_status, api_contract, health_snapshot_id, stats_snapshot_id,
		failure_code, failure_detail, normalization_error_path FROM collection_attempts WHERE hub_id = ? ORDER BY started_at, attempt_id`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list collection attempts: %w", err)
	}
	defer rows.Close()
	var result []CollectionAttempt
	for rows.Next() {
		item, err := scanCollectionAttempt(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read collection attempts: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) GetRawSnapshot(ctx context.Context, snapshotID string) (RawSnapshot, error) {
	database, err := l.DB()
	if err != nil {
		return RawSnapshot{}, err
	}
	return scanRawSnapshot(database.QueryRowContext(ctx, `SELECT snapshot_id, attempt_id, hub_id, response_kind,
		received_started_at, received_completed_at, http_status, api_contract, body FROM raw_snapshots WHERE snapshot_id = ?`, snapshotID))
}

func (l *Lifecycle) ListRawSnapshots(ctx context.Context, hubID string) ([]RawSnapshot, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT snapshot_id, attempt_id, hub_id, response_kind,
		received_started_at, received_completed_at, http_status, api_contract, body
		FROM raw_snapshots WHERE hub_id = ? ORDER BY received_started_at, snapshot_id`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list raw snapshots: %w", err)
	}
	defer rows.Close()
	var result []RawSnapshot
	for rows.Next() {
		item, err := scanRawSnapshot(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read raw snapshots: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListCostObservations(ctx context.Context, hubID string) ([]CostObservation, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT observation_id, snapshot_id, hub_id, device_id, raw_service_identifier,
		usage_updated_at, cost_usd_text, sync_upload_interval_ms, analytics_interval_seconds, source_timezone, source_local_date,
		normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key
		FROM usage_cost_observations WHERE hub_id = ? ORDER BY usage_updated_at, observation_id`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list cost observations: %w", err)
	}
	defer rows.Close()
	var result []CostObservation
	for rows.Next() {
		var item CostObservation
		var usage, timezone, localDate, sync sql.NullString
		if err := rows.Scan(&item.ObservationID, &item.SnapshotID, &item.HubID, &item.DeviceID, &item.RawServiceIdentifier,
			&usage, &item.CostUSDText, &sync, &item.AnalyticsIntervalSeconds, &timezone, &localDate, &item.NormalizationGeneration,
			&item.NormalizationRuleVersion, &item.NormalizationLogicVersion, &item.JSONPath, &item.DedupeState, &item.DedupeKey); err != nil {
			return nil, fmt.Errorf("scan cost observation: %w", err)
		}
		var err error
		item.UsageUpdatedAt, err = parseUTC(usage.String)
		if err != nil {
			return nil, fmt.Errorf("parse cost observation time: %w", err)
		}
		item.SyncUploadIntervalMS = parseNullableInt64(sync)
		item.SourceTimezone = timezone.String
		item.SourceLocalDate = localDate.String
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read cost observations: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListLimitObservations(ctx context.Context, hubID string) ([]LimitObservation, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT observation_id, snapshot_id, hub_id, device_id, raw_service_identifier,
		account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label,
		used_percent, resets_at, sync_upload_interval_ms, limits_refresh_ms, analytics_interval_seconds,
		source_timezone, source_local_date, normalization_generation, normalization_rule_version, normalization_logic_version,
		json_path, dedupe_state, dedupe_key, value_fingerprint
		FROM usage_limit_observations WHERE hub_id = ? ORDER BY provider_updated_at, observation_id`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list limit observations: %w", err)
	}
	defer rows.Close()
	var result []LimitObservation
	for rows.Next() {
		var item LimitObservation
		var updated, reset, sourceTimezone, sourceDate sql.NullString
		var used sql.NullFloat64
		var syncMS, refreshMS sql.NullInt64
		if err := rows.Scan(&item.ObservationID, &item.SnapshotID, &item.HubID, &item.DeviceID, &item.RawServiceIdentifier,
			&item.AccountKey, &updated, &item.WindowKey, &item.NormalizedKind, &item.NormalizedMetric, &item.NormalizedLabel,
			&item.PlanLabel, &used, &reset, &syncMS, &refreshMS, &item.AnalyticsIntervalSeconds, &sourceTimezone, &sourceDate,
			&item.NormalizationGeneration, &item.NormalizationRuleVersion, &item.NormalizationLogicVersion, &item.JSONPath,
			&item.DedupeState, &item.DedupeKey, &item.ValueFingerprint); err != nil {
			return nil, fmt.Errorf("scan limit observation: %w", err)
		}
		item.ProviderUpdatedAt, err = parseUTC(updated.String)
		if err != nil {
			return nil, fmt.Errorf("parse limit observation time: %w", err)
		}
		if used.Valid {
			value := used.Float64
			item.UsedPercent = &value
		}
		if reset.Valid {
			value, parseErr := parseUTC(reset.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse limit reset time: %w", parseErr)
			}
			item.ResetsAt = &value
		}
		if syncMS.Valid {
			value := syncMS.Int64
			item.SyncUploadIntervalMS = &value
		}
		if refreshMS.Valid {
			value := refreshMS.Int64
			item.LimitsRefreshMS = &value
		}
		item.SourceTimezone, item.SourceLocalDate = sourceTimezone.String, sourceDate.String
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read limit observations: %w", err)
	}
	return result, nil
}

func requireOneCollectionAttempt(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read collection attempt count: %w", err)
	}
	if count != 1 {
		return errors.New("collection attempt was not found")
	}
	return nil
}

func validateCostObservation(value CostObservation) error {
	if value.ObservationID == "" || value.SnapshotID == "" || value.HubID == "" || value.DeviceID == "" || value.RawServiceIdentifier == "" || value.UsageUpdatedAt.IsZero() || value.CostUSDText == "" || value.AnalyticsIntervalSeconds <= 0 || value.JSONPath == "" || value.DedupeKey == "" || value.ValueFingerprint == "" {
		return errors.New("cost observation has an empty required field")
	}
	return nil
}

func validateLimitObservation(value LimitObservation) error {
	if value.ObservationID == "" || value.SnapshotID == "" || value.HubID == "" || value.DeviceID == "" || value.RawServiceIdentifier == "" || value.ProviderUpdatedAt.IsZero() || value.JSONPath == "" || value.DedupeKey == "" || value.ValueFingerprint == "" || value.AnalyticsIntervalSeconds <= 0 {
		return errors.New("limit observation has an empty required field")
	}
	return nil
}

func costDedupeState(ctx context.Context, tx *sql.Tx, value CostObservation) (string, error) {
	var existing string
	var amount string
	err := tx.QueryRowContext(ctx, `SELECT dedupe_state, value_fingerprint FROM usage_cost_observations WHERE hub_id = ? AND dedupe_key = ? LIMIT 1`, value.HubID, value.DedupeKey).Scan(&existing, &amount)
	if errors.Is(err, sql.ErrNoRows) {
		return "canonical", nil
	}
	if err != nil {
		return "", fmt.Errorf("check cost duplicate: %w", err)
	}
	if amount == value.ValueFingerprint && existing != "conflict" {
		return "duplicate", nil
	}
	return "conflict", nil
}

func limitDedupeState(ctx context.Context, tx *sql.Tx, value LimitObservation) (string, error) {
	var existing, fingerprint string
	err := tx.QueryRowContext(ctx, `SELECT dedupe_state, value_fingerprint FROM usage_limit_observations WHERE hub_id = ? AND dedupe_key = ? LIMIT 1`, value.HubID, value.DedupeKey).Scan(&existing, &fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "canonical", nil
	}
	if err != nil {
		return "", fmt.Errorf("check limit duplicate: %w", err)
	}
	if fingerprint == value.ValueFingerprint && existing != "conflict" {
		return "duplicate", nil
	}
	return "conflict", nil
}

func nullableInt(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableFloat64(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return utcText(*value)
}

func parseNullableInt64(value sql.NullString) *int64 {
	if !value.Valid || value.String == "" {
		return nil
	}
	var result int64
	if _, err := fmt.Sscan(value.String, &result); err != nil {
		return nil
	}
	return &result
}

func scanCollectionAttempt(scanner interface{ Scan(...any) error }) (CollectionAttempt, error) {
	var item CollectionAttempt
	var started, completed sql.NullString
	var healthStatus, statsStatus sql.NullInt64
	var contract, healthSnapshot, statsSnapshot, code, detail, path sql.NullString
	if err := scanner.Scan(&item.AttemptID, &item.HubID, &item.Trigger, &item.State, &started, &completed,
		&item.AnalyticsIntervalSeconds, &healthStatus, &statsStatus, &contract, &healthSnapshot, &statsSnapshot,
		&code, &detail, &path); err != nil {
		return CollectionAttempt{}, fmt.Errorf("scan collection attempt: %w", err)
	}
	var err error
	item.StartedAt, err = parseUTC(started.String)
	if err != nil {
		return CollectionAttempt{}, err
	}
	if completed.Valid {
		value, parseErr := parseUTC(completed.String)
		if parseErr != nil {
			return CollectionAttempt{}, parseErr
		}
		item.CompletedAt = &value
	}
	if healthStatus.Valid {
		value := int(healthStatus.Int64)
		item.HealthHTTPStatus = &value
	}
	if statsStatus.Valid {
		value := int(statsStatus.Int64)
		item.StatsHTTPStatus = &value
	}
	item.APIContract, item.HealthSnapshotID, item.StatsSnapshotID = contract.String, healthSnapshot.String, statsSnapshot.String
	item.FailureCode, item.FailureDetail, item.NormalizationErrorPath = code.String, detail.String, path.String
	return item, nil
}

func scanRawSnapshot(scanner interface{ Scan(...any) error }) (RawSnapshot, error) {
	var item RawSnapshot
	var started, completed, contract sql.NullString
	if err := scanner.Scan(&item.SnapshotID, &item.AttemptID, &item.HubID, &item.ResponseKind, &started, &completed,
		&item.HTTPStatus, &contract, &item.Body); err != nil {
		return RawSnapshot{}, fmt.Errorf("scan raw snapshot: %w", err)
	}
	var err error
	item.ReceivedStartedAt, err = parseUTC(started.String)
	if err != nil {
		return RawSnapshot{}, err
	}
	item.ReceivedCompletedAt, err = parseUTC(completed.String)
	if err != nil {
		return RawSnapshot{}, err
	}
	item.APIContract = contract.String
	item.Body = append([]byte(nil), item.Body...)
	return item, nil
}
