package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

func (l *Lifecycle) ListRawStatsForNormalization(ctx context.Context, generation int64) ([]domain.RawNormalizationInput, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT r.snapshot_id, r.hub_id, r.body, a.analytics_interval_seconds
		FROM raw_snapshots r JOIN collection_attempts a ON a.attempt_id = r.attempt_id
		WHERE r.response_kind = 'stats' AND NOT EXISTS (
			SELECT 1 FROM normalization_runs n WHERE n.snapshot_id = r.snapshot_id AND n.normalization_generation = ?)
		ORDER BY r.received_completed_at, r.snapshot_id`, generation)
	if err != nil {
		return nil, fmt.Errorf("list raw stats snapshots: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.RawNormalizationInput, 0)
	for rows.Next() {
		var input domain.RawNormalizationInput
		if err := rows.Scan(&input.SnapshotID, &input.HubID, &input.Body, &input.AnalyticsIntervalSeconds); err != nil {
			return nil, fmt.Errorf("scan raw stats snapshot: %w", err)
		}
		input.Body = append([]byte(nil), input.Body...)
		result = append(result, input)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read raw stats snapshots: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) CompleteNormalization(ctx context.Context, snapshotID string, generation int64, rule, logic string, started, completed time.Time, failure string) error {
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin normalization completion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	state := "active"
	var completedValue any = utcText(completed)
	var failureValue any
	if failure != "" {
		state, failureValue = "failed", failure
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE normalization_runs SET state = 'superseded' WHERE snapshot_id = ? AND normalization_generation <> ? AND state = 'active'`, snapshotID, generation); err != nil {
			return fmt.Errorf("supersede prior normalization: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO normalization_runs (snapshot_id, normalization_generation, rule_version, logic_version, state, started_at, completed_at, error_detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(snapshot_id, normalization_generation) DO UPDATE SET
		rule_version = excluded.rule_version, logic_version = excluded.logic_version, state = excluded.state,
		started_at = excluded.started_at, completed_at = excluded.completed_at, error_detail = excluded.error_detail`, snapshotID, generation, rule, logic, state, utcText(started), completedValue, failureValue); err != nil {
		return fmt.Errorf("record normalization completion: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit normalization completion: %w", err)
	}
	return nil
}

func recordActiveNormalizationTx(ctx context.Context, tx *sql.Tx, costs []CostObservation, usage []UsageObservation, limits []LimitObservation) error {
	var snapshotID, rule, logic string
	var generation int64
	if len(costs) > 0 {
		snapshotID, generation, rule, logic = costs[0].SnapshotID, costs[0].NormalizationGeneration, costs[0].NormalizationRuleVersion, costs[0].NormalizationLogicVersion
	} else if len(usage) > 0 {
		snapshotID, generation, rule, logic = usage[0].SnapshotID, usage[0].NormalizationGeneration, usage[0].NormalizationRuleVersion, usage[0].NormalizationLogicVersion
	} else if len(limits) > 0 {
		snapshotID, generation, rule, logic = limits[0].SnapshotID, limits[0].NormalizationGeneration, limits[0].NormalizationRuleVersion, limits[0].NormalizationLogicVersion
	}
	if snapshotID == "" || generation <= 0 || rule == "" || logic == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO normalization_runs (snapshot_id, normalization_generation, rule_version, logic_version, state, started_at, completed_at)
		SELECT snapshot_id, normalization_generation, normalization_rule_version, normalization_logic_version, 'superseded', ?, ?
		FROM usage_cost_observations WHERE snapshot_id = ? AND normalization_generation <> ?
		UNION SELECT snapshot_id, normalization_generation, normalization_rule_version, normalization_logic_version, 'superseded', ?, ?
		FROM usage_analysis_observations WHERE snapshot_id = ? AND normalization_generation <> ?
		UNION SELECT snapshot_id, normalization_generation, normalization_rule_version, normalization_logic_version, 'superseded', ?, ?
		FROM usage_limit_observations WHERE snapshot_id = ? AND normalization_generation <> ?`,
		utcText(time.Now().UTC()), utcText(time.Now().UTC()), snapshotID, generation,
		utcText(time.Now().UTC()), utcText(time.Now().UTC()), snapshotID, generation,
		utcText(time.Now().UTC()), utcText(time.Now().UTC()), snapshotID, generation); err != nil {
		return fmt.Errorf("record superseded normalizations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE normalization_runs SET state = 'superseded' WHERE snapshot_id = ? AND normalization_generation <> ? AND state = 'active'`, snapshotID, generation); err != nil {
		return fmt.Errorf("supersede active normalization: %w", err)
	}
	now := utcText(time.Now().UTC())
	if _, err := tx.ExecContext(ctx, `INSERT INTO normalization_runs (snapshot_id, normalization_generation, rule_version, logic_version, state, started_at, completed_at)
		VALUES (?, ?, ?, ?, 'active', ?, ?) ON CONFLICT(snapshot_id, normalization_generation) DO UPDATE SET
		rule_version = excluded.rule_version, logic_version = excluded.logic_version, state = 'active', completed_at = excluded.completed_at, error_detail = NULL`, snapshotID, generation, rule, logic, now, now); err != nil {
		return fmt.Errorf("record active normalization: %w", err)
	}
	return nil
}
