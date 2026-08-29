package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"time"

	"token-monitor-analytics/internal/domain"
)

type OverviewData = domain.OverviewData

type OverviewHub = domain.OverviewHub

type OverviewRecentLimit = domain.OverviewRecentLimit

// ReadOverviewData reads one consistent, non-secret overview from canonical
// tables. Display calculations and privacy masking remain in the desktop DTO
// boundary.
func (l *Lifecycle) ReadOverviewData(ctx context.Context, now time.Time) (OverviewData, error) {
	if l == nil {
		return OverviewData{}, fmt.Errorf("overview lifecycle is unavailable")
	}
	database, err := l.DB()
	if err != nil {
		return OverviewData{}, err
	}
	result := OverviewData{
		EstimationStatusCounts:  make(map[string]int),
		ReviewActionKindCounts:  make(map[string]int),
		ReviewWarningKindCounts: make(map[string]int),
	}
	if err := readOverviewSettings(ctx, database, &result); err != nil {
		return OverviewData{}, err
	}
	if err := readOverviewHubs(ctx, database, &result); err != nil {
		return OverviewData{}, err
	}
	if err := readOverviewCounts(ctx, database, &result); err != nil {
		return OverviewData{}, err
	}
	items, err := l.deriveReviewItems(ctx)
	if err != nil {
		return OverviewData{}, fmt.Errorf("read overview review items: %w", err)
	}
	for _, item := range items {
		switch item.State {
		case domain.ReviewStateActive, domain.ReviewStateConflict:
			result.ReviewWarningCount++
			result.ReviewWarningKindCounts[string(item.Kind)]++
		default:
			result.ReviewActionCount++
			result.ReviewActionKindCounts[string(item.Kind)]++
		}
	}
	if err := readOverviewEstimationCounts(ctx, database, &result); err != nil {
		return OverviewData{}, err
	}
	if err := readOverviewRecentLimits(ctx, database, &result, now.UTC()); err != nil {
		return OverviewData{}, err
	}
	databasePath, err := l.DatabasePath()
	if err != nil {
		return OverviewData{}, err
	}
	info, err := os.Stat(databasePath)
	if err != nil {
		return OverviewData{}, fmt.Errorf("read overview database size: %w", err)
	}
	result.DatabaseSizeBytes = info.Size()
	return result, nil
}

func readOverviewSettings(ctx context.Context, database *sql.DB, result *OverviewData) error {
	var confirmed int
	if err := database.QueryRowContext(ctx, `SELECT timezone_confirmed FROM display_settings WHERE singleton = 1`).Scan(&confirmed); err != nil {
		return fmt.Errorf("read overview display settings: %w", err)
	}
	result.TimezoneConfirmed = confirmed == 1
	return nil
}

func readOverviewHubs(ctx context.Context, database *sql.DB, result *OverviewData) (err error) {
	rows, err := database.QueryContext(ctx, `
		SELECT h.hub_id, h.display_name, h.enabled, h.collection_enabled, h.collection_interval_seconds,
		       hs.state,
		       EXISTS(SELECT 1 FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state = 'started'),
		       COALESCE((SELECT ca.state FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state IN ('succeeded', 'failed', 'skipped') ORDER BY ca.completed_at DESC, ca.attempt_id DESC LIMIT 1), ''),
		       (SELECT ca.completed_at FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state IN ('succeeded', 'failed', 'skipped') ORDER BY ca.completed_at DESC, ca.attempt_id DESC LIMIT 1),
		       (SELECT MAX(ca.completed_at) FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state = 'succeeded'),
		       (SELECT MAX(ca.completed_at) FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state = 'failed'),
		       (SELECT MAX(ca.completed_at) FROM collection_attempts ca WHERE ca.hub_id = h.hub_id AND ca.state = 'skipped')
		FROM hubs h
		JOIN hub_connection_statuses hs ON hs.hub_id = h.hub_id
		ORDER BY h.created_at, h.hub_id`)
	if err != nil {
		return fmt.Errorf("read overview Hubs: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close overview Hub rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var hub OverviewHub
		var enabled, collectionEnabled, collectionRunning int
		var lastCollection, lastSuccess, lastFailure, lastSkipped sql.NullString
		if err := rows.Scan(&hub.ID, &hub.DisplayName, &enabled, &collectionEnabled, &hub.CollectionIntervalSeconds,
			&hub.ConnectionState, &collectionRunning, &hub.LastCollectionState, &lastCollection, &lastSuccess, &lastFailure, &lastSkipped); err != nil {
			return fmt.Errorf("scan overview Hub: %w", err)
		}
		hub.Enabled = enabled != 0
		hub.CollectionEnabled = collectionEnabled != 0
		hub.CollectionRunning = collectionRunning != 0
		var err error
		if hub.LastCollectionAt, err = parseOverviewTime(lastCollection); err != nil {
			return overviewTimeError("last collection", err)
		}
		if hub.LastSuccessAt, err = parseOverviewTime(lastSuccess); err != nil {
			return overviewTimeError("last success", err)
		}
		if hub.LastFailureAt, err = parseOverviewTime(lastFailure); err != nil {
			return overviewTimeError("last failure", err)
		}
		if hub.LastSkippedAt, err = parseOverviewTime(lastSkipped); err != nil {
			return overviewTimeError("last skip", err)
		}
		result.Hubs = append(result.Hubs, hub)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read overview Hubs: %w", err)
	}
	return nil
}

func readOverviewCounts(ctx context.Context, database *sql.DB, result *OverviewData) error {
	var oldest, latest sql.NullString
	if err := database.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM recalculation_requests WHERE state = 'failed'),
		  (SELECT COUNT(*) FROM raw_snapshots),
		  (SELECT MIN(received_completed_at) FROM raw_snapshots),
		  (SELECT MAX(received_completed_at) FROM raw_snapshots),
		  (SELECT COUNT(*) FROM services WHERE archived_at IS NULL),
		  (SELECT COUNT(*) FROM logical_accounts WHERE archived_at IS NULL),
		  (SELECT COUNT(*) FROM usage_limit_source_links),
		  (SELECT COUNT(*) FROM usage_cost_source_account_links),
		  (SELECT COUNT(*) FROM usage_cost_source_completeness WHERE state = 'confirmed')`).Scan(
		&result.RecalculationFailureCount, &result.RawSnapshotCount, &oldest, &latest,
		&result.ServiceCount, &result.LogicalAccountCount, &result.LimitAssociationCount,
		&result.CostAssociationCount, &result.ConfirmedCompletenessCount); err != nil {
		return fmt.Errorf("read overview counts: %w", err)
	}
	var err error
	if result.OldestSnapshotAt, err = parseOverviewTime(oldest); err != nil {
		return overviewTimeError("oldest snapshot", err)
	}
	if result.LatestSnapshotAt, err = parseOverviewTime(latest); err != nil {
		return overviewTimeError("latest snapshot", err)
	}
	return nil
}

func readOverviewEstimationCounts(ctx context.Context, database *sql.DB, result *OverviewData) (err error) {
	rows, err := database.QueryContext(ctx, `SELECT status, COUNT(*) FROM estimation_results GROUP BY status ORDER BY status`)
	if err != nil {
		return fmt.Errorf("read overview estimation counts: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close overview estimation count rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return fmt.Errorf("scan overview estimation count: %w", err)
		}
		result.EstimationStatusCounts[status] = count
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read overview estimation counts: %w", err)
	}
	return nil
}

func readOverviewRecentLimits(ctx context.Context, database *sql.DB, result *OverviewData, now time.Time) (err error) {
	nowText := utcText(now)
	rows, err := database.QueryContext(ctx, `
		WITH valid AS (
		  SELECT uls.usage_limit_source_id, ci.calculation_interval_id,
		         usl.logical_account_id, usl.limit_definition_id,
		         s.name AS service_name, la.display_name AS account_name, ld.meaning AS limit_name,
		         ld.cycle_type, ulo.used_percent, ulo.resets_at, ulo.provider_updated_at,
		         MAX(ulo.analytics_interval_seconds,
		             COALESCE((ulo.sync_upload_interval_ms + 999) / 1000, 0),
		             COALESCE((ulo.limits_refresh_ms + 999) / 1000, 0)) AS expected_seconds,
		         LAG(ulo.used_percent) OVER (
		           PARTITION BY ci.calculation_interval_id
		           ORDER BY ulo.provider_updated_at, ulo.observation_id
		         ) AS previous_used_percent
		  FROM usage_limit_observations ulo
		  JOIN usage_limit_sources uls
		    ON uls.hub_id = ulo.hub_id AND uls.device_id = ulo.device_id
		   AND uls.raw_service_identifier = ulo.raw_service_identifier
		   AND uls.account_key = ulo.account_key AND uls.window_key = ulo.window_key
		   AND uls.normalized_kind = ulo.normalized_kind AND uls.normalized_metric = ulo.normalized_metric
		   AND uls.normalized_label = ulo.normalized_label
		  JOIN usage_limit_source_links usl
		    ON usl.usage_limit_source_id = uls.usage_limit_source_id
		   AND usl.valid_from <= ?
		   AND (usl.valid_to IS NULL OR ? < usl.valid_to)
		   AND usl.valid_from <= ulo.provider_updated_at
		   AND (usl.valid_to IS NULL OR ulo.provider_updated_at < usl.valid_to)
		  JOIN calculation_intervals ci
		    ON ci.usage_limit_source_id = uls.usage_limit_source_id
		   AND ci.logical_account_id = usl.logical_account_id
		   AND ci.limit_definition_id = usl.limit_definition_id
		   AND ci.state = 'estimable'
		   AND ci.valid_from <= ulo.provider_updated_at AND ulo.provider_updated_at < ci.valid_to
		  JOIN logical_accounts la ON la.logical_account_id = usl.logical_account_id AND la.archived_at IS NULL
		  JOIN limit_definitions ld ON ld.limit_definition_id = usl.limit_definition_id AND ld.archived_at IS NULL
		  JOIN services s ON s.service_id = la.service_id AND s.service_id = ld.service_id AND s.archived_at IS NULL
		  WHERE ulo.dedupe_state = 'canonical' AND ulo.normalized_metric = 'percent'
		    AND ulo.used_percent BETWEEN 0 AND 100
		), increases AS (
		  SELECT *, ROW_NUMBER() OVER (
		    PARTITION BY usage_limit_source_id ORDER BY provider_updated_at DESC
		  ) AS increase_rank
		  FROM valid WHERE previous_used_percent IS NOT NULL AND used_percent > previous_used_percent
		), latest_ranked AS (
		  SELECT usage_limit_source_id, used_percent AS latest_used_percent,
		         resets_at AS latest_resets_at, provider_updated_at AS latest_observation_at,
		         expected_seconds AS latest_expected_seconds,
		         ROW_NUMBER() OVER (
		           PARTITION BY usage_limit_source_id ORDER BY provider_updated_at DESC
		         ) AS observation_rank
		  FROM valid
		)
		SELECT i.logical_account_id, i.limit_definition_id, i.service_name, i.account_name,
		       i.limit_name, i.cycle_type, l.latest_used_percent,
		       (SELECT ers.estimated_limit
		          FROM estimation_result_series ers
		          JOIN estimation_results er ON er.estimation_result_id = ers.estimation_result_id
		         WHERE ers.calculation_interval_id = i.calculation_interval_id
		           AND ers.usage_limit_source_id = i.usage_limit_source_id
		           AND ers.logical_account_id = i.logical_account_id
		           AND er.status IN ('provisional', 'verified')
		         ORDER BY er.updated_at DESC, er.estimation_result_id DESC
		         LIMIT 1) AS estimated_limit,
		       l.latest_resets_at, i.provider_updated_at,
		       l.latest_observation_at, l.latest_expected_seconds
		FROM increases i JOIN latest_ranked l USING (usage_limit_source_id)
		WHERE i.increase_rank = 1 AND l.observation_rank = 1
		ORDER BY i.provider_updated_at DESC, i.usage_limit_source_id
		LIMIT 4`, nowText, nowText)
	if err != nil {
		return fmt.Errorf("read overview recent limits: %w", err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil && err == nil {
			err = fmt.Errorf("close overview recent limit rows: %w", closeErr)
		}
	}()
	for rows.Next() {
		var item OverviewRecentLimit
		var reset sql.NullString
		var estimatedLimit sql.NullFloat64
		var increase, latest string
		var expectedSeconds int64
		if err := rows.Scan(&item.LogicalAccountID, &item.LimitDefinitionID, &item.ServiceName,
			&item.AccountName, &item.LimitName, &item.CycleType, &item.UsedPercent, &estimatedLimit, &reset,
			&increase, &latest, &expectedSeconds); err != nil {
			return fmt.Errorf("scan overview recent limit: %w", err)
		}
		if estimatedLimit.Valid {
			value := estimatedLimit.Float64
			item.EstimatedLimit = &value
		}
		var err error
		if item.ResetsAt, err = parseOverviewTime(reset); err != nil {
			return overviewTimeError("limit reset", err)
		}
		if item.LastIncreaseAt, err = parseUTC(increase); err != nil {
			return overviewTimeError("limit increase", err)
		}
		if item.LatestObservationAt, err = parseUTC(latest); err != nil {
			return overviewTimeError("latest limit observation", err)
		}
		item.ExpectedInterval = time.Duration(expectedSeconds) * time.Second
		result.RecentLimits = append(result.RecentLimits, item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read overview recent limits: %w", err)
	}
	return nil
}

func parseOverviewTime(value sql.NullString) (*time.Time, error) {
	if !value.Valid || value.String == "" {
		return nil, nil
	}
	parsed, err := parseUTC(value.String)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func overviewTimeError(field string, err error) error {
	return fmt.Errorf("parse overview %s time: %w", field, err)
}
