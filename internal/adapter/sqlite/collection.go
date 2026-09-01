package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

type CollectionAttempt = domain.CollectionAttempt

type RawSnapshot = domain.RawSnapshot

type CostObservation = domain.CostObservation

type UsageObservation = domain.CollectionUsageObservation

type LimitObservation = domain.LimitObservation

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
		if observation.UsageCostSourceID != "" {
			if err := ensureUsageCostSourceTx(ctx, tx, UsageCostSource{
				ID: observation.UsageCostSourceID, HubID: observation.HubID, DeviceID: observation.DeviceID,
				RawServiceIdentifier: observation.RawServiceIdentifier, CreatedAt: observation.UsageUpdatedAt,
			}); err != nil {
				return err
			}
		}
		state, err := costDedupeState(ctx, tx, observation)
		if err != nil {
			return err
		}
		if state == "canonical" {
			regressed, err := costTimestampRegressed(ctx, tx, observation.HubID, observation.DeviceID, observation.RawServiceIdentifier, observation.NormalizationGeneration, observation.UsageUpdatedAt, "usage_cost_observations")
			if err != nil {
				return err
			}
			if regressed {
				state = "conflict"
			}
		}
		if state == "conflict" {
			if _, err := tx.ExecContext(ctx, `UPDATE usage_cost_observations SET dedupe_state = 'conflict' WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? AND value_fingerprint <> ?`, observation.HubID, observation.DedupeKey, observation.NormalizationGeneration, observation.ValueFingerprint); err != nil {
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
		// A missing window key is retained as an unconfirmed raw observation but
		// does not identify a UsageLimitSource.
		if observation.WindowKey != "" && observation.UsageLimitSourceID != "" {
			if err := ensureUsageLimitSourceTx(ctx, tx, UsageLimitSource{
				ID: observation.UsageLimitSourceID, HubID: observation.HubID, DeviceID: observation.DeviceID,
				AccountKey: observation.AccountKey, RawServiceIdentifier: observation.RawServiceIdentifier,
				WindowKey: observation.WindowKey, NormalizedKind: observation.NormalizedKind,
				NormalizedMetric: observation.NormalizedMetric, NormalizedLabel: observation.NormalizedLabel,
				CreatedAt: observation.ProviderUpdatedAt,
			}); err != nil {
				return err
			}
		}
		if observation.HubAccountCandidateID != "" {
			if err := upsertHubAccountCandidateFromLimitObservationTx(ctx, tx, observation); err != nil {
				return err
			}
		}
		if observation.IdentificationCandidateID != "" && observation.PlanLabel != "" {
			if err := upsertIdentificationCandidateFromLimitObservationTx(ctx, tx, observation); err != nil {
				return err
			}
		}
		state, err := limitDedupeState(ctx, tx, observation)
		if err != nil {
			return err
		}
		if state == "conflict" || observation.WindowKeyConflict {
			if _, err := tx.ExecContext(ctx, `UPDATE usage_limit_observations SET dedupe_state = 'conflict' WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ?`, observation.HubID, observation.DedupeKey, observation.NormalizationGeneration); err != nil {
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
		if observation.AbsoluteUsedText != "" || observation.AbsoluteLimitText != "" || observation.AbsoluteRemainingText != "" || observation.Currency != "" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO usage_limit_amount_observations (observation_id, used_text, limit_text, remaining_text, currency) VALUES (?, ?, ?, ?, ?)`, observation.ObservationID, nullText(observation.AbsoluteUsedText), nullText(observation.AbsoluteLimitText), nullText(observation.AbsoluteRemainingText), nullText(observation.Currency)); err != nil {
				return fmt.Errorf("insert limit amount observation: %w", err)
			}
		}
	}
	return nil
}

// InsertObservations commits cost and limit observations atomically. If either
// side fails, no normalized row is committed and the raw snapshot remains the
// evidence of the attempted collection.
func (l *Lifecycle) InsertObservations(ctx context.Context, costs []CostObservation, limits []LimitObservation) error {
	return l.InsertAllObservations(ctx, costs, nil, limits)
}

// InsertAllObservations commits every normalized observation derived from one
// raw snapshot in one transaction.
func (l *Lifecycle) InsertAllObservations(ctx context.Context, costs []CostObservation, usage []UsageObservation, limits []LimitObservation) error {
	if len(costs) == 0 && len(usage) == 0 && len(limits) == 0 {
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
	if err := l.insertUsageObservationsTx(ctx, tx, usage); err != nil {
		return err
	}
	if err := l.insertLimitObservationsTx(ctx, tx, limits); err != nil {
		return err
	}
	if err := recordActiveNormalizationTx(ctx, tx, costs, usage, limits); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit observations: %w", err)
	}
	return nil
}

func (l *Lifecycle) insertUsageObservationsTx(ctx context.Context, tx *sql.Tx, observations []UsageObservation) error {
	for _, observation := range observations {
		if err := validateUsageObservation(observation); err != nil {
			return err
		}
		if observation.UsageCostSourceID != "" {
			if err := ensureUsageCostSourceTx(ctx, tx, UsageCostSource{ID: observation.UsageCostSourceID, HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, CreatedAt: observation.UsageUpdatedAt}); err != nil {
				return err
			}
		}
		state, err := usageDedupeState(ctx, tx, observation)
		if err != nil {
			return err
		}
		if state == "canonical" {
			regressed, err := costTimestampRegressed(ctx, tx, observation.HubID, observation.DeviceID, observation.RawServiceIdentifier, observation.NormalizationGeneration, observation.UsageUpdatedAt, "usage_analysis_observations")
			if err != nil {
				return err
			}
			if regressed {
				state = "conflict"
			}
		}
		if state == "conflict" {
			if _, err := tx.ExecContext(ctx, `UPDATE usage_analysis_observations SET dedupe_state = 'conflict' WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? AND value_fingerprint <> ?`, observation.HubID, observation.DedupeKey, observation.NormalizationGeneration, observation.ValueFingerprint); err != nil {
				return fmt.Errorf("mark usage conflict: %w", err)
			}
		}
		modelTokens, err := json.Marshal(observation.ModelTokens)
		if err != nil {
			return fmt.Errorf("encode usage model tokens: %w", err)
		}
		modelCosts, err := json.Marshal(observation.ModelCosts)
		if err != nil {
			return fmt.Errorf("encode usage model costs: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO usage_analysis_observations
			(usage_observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at,
			token_count, api_cost_usd_text, model_tokens_json, model_costs_json, source_timezone, source_local_date,
			normalization_generation, normalization_rule_version, normalization_logic_version, json_path,
			dedupe_state, dedupe_key, value_fingerprint)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			observation.ObservationID, observation.SnapshotID, observation.HubID, observation.DeviceID,
			observation.RawServiceIdentifier, utcText(observation.UsageUpdatedAt), observation.TokenCount,
			nullText(observation.APICostUSDText), string(modelTokens), string(modelCosts), nullText(observation.SourceTimezone),
			nullText(observation.SourceLocalDate), observation.NormalizationGeneration, observation.NormalizationRuleVersion,
			observation.NormalizationLogicVersion, observation.JSONPath, state, observation.DedupeKey, observation.ValueFingerprint); err != nil {
			return fmt.Errorf("insert usage observation: %w", err)
		}
	}
	return nil
}

func upsertHubAccountCandidateFromLimitObservationTx(ctx context.Context, tx *sql.Tx, observation LimitObservation) error {
	if observation.AccountKey == "" {
		return nil
	}
	var serviceID string
	err := tx.QueryRowContext(ctx, `SELECT service_id FROM service_identifier_mappings WHERE identifier_kind = 'usage_limit' AND raw_identifier = ? AND valid_from <= ? AND (valid_to IS NULL OR ? < valid_to) ORDER BY valid_from DESC LIMIT 1`, observation.RawServiceIdentifier, catalogPeriodText(observation.ProviderUpdatedAt), catalogPeriodText(observation.ProviderUpdatedAt)).Scan(&serviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("resolve usage limit service for Hub account candidate: %w", err)
	}
	candidate := HubAccountCandidate{
		ID: observation.HubAccountCandidateID, HubID: observation.HubID, ServiceID: serviceID,
		AccountKey: observation.AccountKey,
		State:      domain.HubAccountCandidateUnconfirmed, FirstObservedAt: normalizedTimePtr(&observation.ProviderUpdatedAt),
		LastObservedAt: normalizedTimePtr(&observation.ProviderUpdatedAt), CreatedAt: observation.ProviderUpdatedAt, UpdatedAt: observation.ProviderUpdatedAt,
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	return upsertHubAccountCandidateTx(ctx, tx, candidate)
}

func upsertIdentificationCandidateFromLimitObservationTx(ctx context.Context, tx *sql.Tx, observation LimitObservation) error {
	candidate := IdentificationCandidate{ID: observation.IdentificationCandidateID, RawLimitServiceIdentifier: observation.RawServiceIdentifier, RawReportedPlanName: observation.PlanLabel, State: domain.CandidateUnconfirmed, FirstObservedAt: normalizedTimePtr(&observation.ProviderUpdatedAt), LastObservedAt: normalizedTimePtr(&observation.ProviderUpdatedAt), CreatedAt: observation.ProviderUpdatedAt, UpdatedAt: observation.ProviderUpdatedAt}
	if err := candidate.Validate(); err != nil {
		return err
	}
	var existing IdentificationCandidate
	err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE raw_limit_service_identifier = ? AND raw_reported_plan_name = ? ORDER BY created_at, candidate_id LIMIT 1`, candidate.RawLimitServiceIdentifier, candidate.RawReportedPlanName), &existing)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `INSERT INTO identification_candidates (candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, first_observed_at, last_observed_at, created_at, updated_at) VALUES (?, ?, ?, 'unconfirmed', ?, ?, ?, ?)`, candidate.ID, candidate.RawLimitServiceIdentifier, candidate.RawReportedPlanName, catalogPeriodText(*candidate.FirstObservedAt), catalogPeriodText(*candidate.LastObservedAt), utcText(candidate.CreatedAt), utcText(candidate.UpdatedAt)); err != nil {
			return fmt.Errorf("insert observed identification candidate: %w", err)
		}
		if err := appendCatalogAuditAndRequest(ctx, tx, catalogMutationForObservation("observe", "identification_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt), nil, candidate); err != nil {
			return err
		}
		existing = candidate
	} else if err != nil {
		return fmt.Errorf("read observed identification candidate: %w", err)
	} else {
		before := existing
		if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET first_observed_at = CASE WHEN first_observed_at IS NULL OR ? < first_observed_at THEN ? ELSE first_observed_at END, last_observed_at = CASE WHEN last_observed_at IS NULL OR ? > last_observed_at THEN ? ELSE last_observed_at END, updated_at = ? WHERE candidate_id = ?`, catalogPeriodText(*candidate.FirstObservedAt), catalogPeriodText(*candidate.FirstObservedAt), catalogPeriodText(*candidate.LastObservedAt), catalogPeriodText(*candidate.LastObservedAt), utcText(candidate.UpdatedAt), existing.ID); err != nil {
			return fmt.Errorf("update observed identification candidate: %w", err)
		}
		existing.FirstObservedAt, existing.LastObservedAt = minTimePtr(existing.FirstObservedAt, candidate.FirstObservedAt), maxTimePtr(existing.LastObservedAt, candidate.LastObservedAt)
		existing.UpdatedAt = candidate.UpdatedAt
		if err := appendCatalogAuditAndRequest(ctx, tx, catalogMutationForObservation("observe", "identification_candidate", existing.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt), before, existing); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO identification_candidate_observations (observation_id, candidate_id, hub_id, hub_account_display, observed_at) VALUES (?, ?, ?, ?, ?)`, observation.ObservationID, existing.ID, observation.HubID, observation.PlanLabel, catalogPeriodText(observation.ProviderUpdatedAt)); err != nil {
		return fmt.Errorf("insert identification candidate observation: %w", err)
	}
	return nil
}

func minTimePtr(a, b *time.Time) *time.Time {
	if a == nil || (b != nil && b.Before(*a)) {
		return normalizedTimePtr(b)
	}
	return normalizedTimePtr(a)
}

func maxTimePtr(a, b *time.Time) *time.Time {
	if a == nil || (b != nil && b.After(*a)) {
		return normalizedTimePtr(b)
	}
	return normalizedTimePtr(a)
}

func (l *Lifecycle) ListCollectionAttempts(ctx context.Context, hubID string) (result []CollectionAttempt, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT attempt_id, hub_id, trigger, state, started_at, completed_at,
		analytics_interval_seconds, health_http_status, stats_http_status, api_contract, health_snapshot_id, stats_snapshot_id,
		failure_code, failure_detail, normalization_error_path FROM collection_attempts WHERE hub_id = ? ORDER BY started_at DESC, attempt_id DESC`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list collection attempts: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close collection attempt rows: %w", closeErr)
		}
	}()
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

func (l *Lifecycle) ListRawSnapshots(ctx context.Context, hubID string) (result []RawSnapshot, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT snapshot_id, attempt_id, hub_id, response_kind,
		received_started_at, received_completed_at, http_status, api_contract, body
		FROM raw_snapshots WHERE hub_id = ? ORDER BY received_completed_at DESC, snapshot_id DESC`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list raw snapshots: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close raw snapshot rows: %w", closeErr)
		}
	}()
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

func (l *Lifecycle) ListCostObservations(ctx context.Context, hubID string) (result []CostObservation, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT observation_id, snapshot_id, hub_id, device_id, raw_service_identifier,
		usage_updated_at, cost_usd_text, sync_upload_interval_ms, analytics_interval_seconds, source_timezone, source_local_date,
		normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key
		FROM usage_cost_observations WHERE hub_id = ? ORDER BY usage_updated_at DESC, observation_id DESC`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list cost observations: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close cost observation rows: %w", closeErr)
		}
	}()
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

func (l *Lifecycle) ListLimitObservations(ctx context.Context, hubID string) (result []LimitObservation, err error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT observation_id, snapshot_id, hub_id, device_id, raw_service_identifier,
		account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label,
		used_percent, resets_at, sync_upload_interval_ms, limits_refresh_ms, analytics_interval_seconds,
		source_timezone, source_local_date, normalization_generation, normalization_rule_version, normalization_logic_version,
		json_path, dedupe_state, dedupe_key, value_fingerprint
		FROM usage_limit_observations WHERE hub_id = ? ORDER BY provider_updated_at DESC, observation_id DESC`, hubID)
	if err != nil {
		return nil, fmt.Errorf("list limit observations: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close limit observation rows: %w", closeErr)
		}
	}()
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

func validateUsageObservation(value UsageObservation) error {
	if value.ObservationID == "" || value.SnapshotID == "" || value.HubID == "" || value.DeviceID == "" || value.RawServiceIdentifier == "" || value.UsageUpdatedAt.IsZero() || value.TokenCount < 0 || value.NormalizationGeneration <= 0 || value.JSONPath == "" || value.DedupeKey == "" || value.ValueFingerprint == "" {
		return errors.New("usage observation has an empty or invalid required field")
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
	err := tx.QueryRowContext(ctx, `SELECT dedupe_state, value_fingerprint FROM usage_cost_observations WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? LIMIT 1`, value.HubID, value.DedupeKey, value.NormalizationGeneration).Scan(&existing, &amount)
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

func usageDedupeState(ctx context.Context, tx *sql.Tx, value UsageObservation) (string, error) {
	var existing, fingerprint string
	err := tx.QueryRowContext(ctx, `SELECT dedupe_state, value_fingerprint FROM usage_analysis_observations WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? LIMIT 1`, value.HubID, value.DedupeKey, value.NormalizationGeneration).Scan(&existing, &fingerprint)
	if errors.Is(err, sql.ErrNoRows) {
		return "canonical", nil
	}
	if err != nil {
		return "", fmt.Errorf("check usage duplicate: %w", err)
	}
	if fingerprint == value.ValueFingerprint && existing != "conflict" {
		return "duplicate", nil
	}
	return "conflict", nil
}

func limitDedupeState(ctx context.Context, tx *sql.Tx, value LimitObservation) (string, error) {
	var existing, fingerprint string
	err := tx.QueryRowContext(ctx, `SELECT dedupe_state, value_fingerprint FROM usage_limit_observations WHERE hub_id = ? AND dedupe_key = ? AND normalization_generation = ? LIMIT 1`, value.HubID, value.DedupeKey, value.NormalizationGeneration).Scan(&existing, &fingerprint)
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

func costTimestampRegressed(ctx context.Context, tx *sql.Tx, hubID, deviceID, rawServiceIdentifier string, generation int64, observedAt time.Time, table string) (bool, error) {
	if table != "usage_cost_observations" && table != "usage_analysis_observations" {
		return false, errors.New("usage timestamp regression table is invalid")
	}
	rows, err := tx.QueryContext(ctx, `SELECT usage_updated_at FROM `+table+` WHERE hub_id = ? AND device_id = ? AND raw_service_identifier = ? AND normalization_generation = ?`, hubID, deviceID, rawServiceIdentifier, generation)
	if err != nil {
		return false, fmt.Errorf("read prior usage timestamps: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var text string
		if err := rows.Scan(&text); err != nil {
			return false, fmt.Errorf("scan prior usage timestamp: %w", err)
		}
		prior, err := parseUTC(text)
		if err != nil {
			return false, err
		}
		if observedAt.Before(prior) {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("read prior usage timestamps: %w", err)
	}
	return false, nil
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
