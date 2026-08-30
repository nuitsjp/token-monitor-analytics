package sqlite

import (
	"context"
	"testing"
	"time"
)

func TestListCurrentLimitSeriesUsesExactSourceAndAssociationPeriod(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO hubs (hub_id, display_name, url, enabled, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('view-hub', 'View Hub', 'http://localhost:17321', 1, 1, 300, ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, completed_at, analytics_interval_seconds) VALUES ('view-attempt', 'view-hub', 'manual', 'succeeded', ?, ?, 300)`, []any{utcText(now.Add(-time.Minute)), utcText(now)}},
		{`INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body) VALUES ('view-snapshot', 'view-attempt', 'view-hub', 'stats', ?, ?, 200, ?)`, []any{utcText(now.Add(-time.Minute)), utcText(now), []byte(`{}`)}},
		{`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('view-service', 'Provider', 'View Service', 'view.service', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('view-definition', 'view-service', 'weekly', 'Weekly', 'percent', 'not_applicable', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('view-account', 'view-service', 'View Account', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('view-source', 'view-hub', 'view-device', 'view-account-key', 'view.raw', 'view-window', 'weekly', 'percent', 'View Weekly', ?)`, []any{utcText(now)}},
		{`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at) VALUES ('view-association', 'view-source', 'view-account', 'view-definition', ?, ?, ?)`, []any{utcText(now.Add(-time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, archived_at, created_at, updated_at) VALUES ('archived-account', 'view-service', 'Archived', ?, ?, ?)`, []any{utcText(now.Add(-time.Minute)), utcText(now), utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('archived-source', 'view-hub', 'archived-device', 'archived-key', 'archived.raw', 'archived-window', 'weekly', 'percent', 'Archived', ?)`, []any{utcText(now)}},
		{`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at) VALUES ('archived-association', 'archived-source', 'archived-account', 'view-definition', ?, ?, ?)`, []any{utcText(now.Add(-time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('past-account', 'view-service', 'Past', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('past-source', 'view-hub', 'past-device', 'past-key', 'past.raw', 'past-window', 'weekly', 'percent', 'Past', ?)`, []any{utcText(now)}},
		{`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at) VALUES ('past-association', 'past-source', 'past-account', 'view-definition', ?, ?, ?, ?)`, []any{utcText(now.Add(-2 * time.Hour)), utcText(now.Add(-time.Minute)), utcText(now), utcText(now)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('view-interval', 'view-service', 'view-account', 'view-source', 'view-definition', 'weekly', ?, ?, 'estimable', '', '["view-boundary"]', ?, ?)`, []any{utcText(now.Add(-time.Hour)), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO calculation_boundaries (calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id, boundary_at, boundary_kind, reason, related_id, created_at) VALUES ('view-boundary', 'view-service', 'view-account', 'view-source', ?, 'hub_switch', 'hub switch confirmed', 'switch-1', ?)`, []any{utcText(now.Add(-time.Hour)), utcText(now)}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('view-observation', 'view-snapshot', 'view-hub', 'view-device', 'view.raw', 'view-account-key', ?, 'view-window', 'weekly', 'percent', 'View Weekly', 'View Plan', 25.5, ?, 300, 1, 'rule', 'logic', '$.limit', 'canonical', 'view-dedupe', 'view-fingerprint')`, []any{utcText(now.Add(-time.Minute)), utcText(now.Add(time.Hour))}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('view-conflict-other-label', 'view-snapshot', 'view-hub', 'view-device', 'view.raw', 'view-account-key', ?, 'view-window', 'weekly', 'percent', 'Other label', 'View Plan', 30, ?, 300, 1, 'rule', 'logic', '$.limit2', 'conflict', 'view-dedupe-2', 'view-fingerprint-2')`, []any{utcText(now.Add(-2 * time.Minute)), utcText(now.Add(time.Hour))}},
		{`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, used_percent, resets_at, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('view-conflict', 'view-snapshot', 'view-hub', 'view-device', 'view.raw', 'view-account-key', ?, 'view-window', 'weekly', 'percent', 'View Weekly', 'View Plan', 30, ?, 300, 1, 'rule', 'logic', '$.limit3', 'conflict', 'view-dedupe-3', 'view-fingerprint-3')`, []any{utcText(now.Add(-3 * time.Minute)), utcText(now.Add(time.Hour))}},
	}
	for _, statement := range statements {
		if _, err := database.ExecContext(context.Background(), statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	items, err := lifecycle.ListCurrentLimitSeries(context.Background(), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].AssociationID != "view-association" || items[0].RemainingPercent == nil || *items[0].RemainingPercent != 74.5 || items[0].LatestObservationAt == nil || items[0].SeriesState != "inconsistent" {
		t.Fatalf("current series = %#v", items)
	}
	if items[0].Interval == nil || len(items[0].Interval.Boundaries) != 1 || items[0].Interval.Boundaries[0].Kind != "hub_switch" {
		t.Fatalf("boundary history = %#v", items[0].Interval)
	}
}

func TestListCalculationIntervalViewsReadsExcludedHistoryAndKnownBoundaries(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('history-service', 'Provider', 'History Service', 'history.service', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('history-definition', 'history-service', 'weekly', 'Weekly tokens', 'percent', 'confirmed', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('history-account', 'history-service', 'History account', ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO hubs (hub_id, display_name, url, enabled, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES ('history-hub', 'History Hub', 'http://localhost:17321', 1, 1, 300, ?, ?)`, []any{utcText(now), utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('history-source', 'history-hub', 'history-device', 'history-account-key', 'history.raw', 'history-window', 'weekly', 'percent', 'History', ?)`, []any{utcText(now)}},
		{`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('history-other-source', 'history-hub', 'other-device', 'other-account-key', 'history.raw', 'other-window', 'weekly', 'percent', 'Other', ?)`, []any{utcText(now)}},
		{`INSERT INTO calculation_boundaries (calculation_boundary_id, service_id, logical_account_id, usage_limit_source_id, boundary_at, boundary_kind, reason, related_id, created_at) VALUES ('history-boundary', 'history-service', 'history-account', 'history-source', ?, 'association', 'association changed', 'association-1', ?)`, []any{utcText(now.Add(time.Hour)), utcText(now)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('history-current', 'history-service', 'history-account', 'history-source', 'history-definition', '', 'weekly', ?, ?, 'estimable', '', '["history-boundary","missing-boundary"]', ?, ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('history-excluded', 'history-service', 'history-account', 'history-source', 'history-definition', '', 'weekly', ?, ?, 'excluded', 'missing completeness confirmation', '[]', ?, ?)`, []any{utcText(now.Add(time.Hour)), utcText(now.Add(2 * time.Hour)), utcText(now), utcText(now)}},
		{`INSERT INTO calculation_intervals (calculation_interval_id, service_id, logical_account_id, usage_limit_source_id, limit_definition_id, plan_version_id, cycle_type, valid_from, valid_to, state, exclusion_reason, boundary_ids_json, created_at, updated_at) VALUES ('history-other', 'history-service', 'history-account', 'history-other-source', 'history-definition', '', 'weekly', ?, ?, 'estimable', '', '[]', ?, ?)`, []any{utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)}},
	} {
		if _, err := database.ExecContext(t.Context(), statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	items, err := lifecycle.ListCalculationIntervalViews(t.Context(), "history-service", "history-account", "history-definition", "history-source")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("history intervals = %#v", items)
	}
	if items[0].ID != "history-current" || items[0].State != "estimable" || items[0].ValidFrom != now || items[0].ValidTo != now.Add(time.Hour) {
		t.Fatalf("current interval view = %#v", items[0])
	}
	if len(items[0].BoundaryIDs) != 2 || len(items[0].Boundaries) != 1 || items[0].Boundaries[0].ID != "history-boundary" || items[0].Boundaries[0].Kind != "association" || items[0].Boundaries[0].RelatedID != "association-1" {
		t.Fatalf("current interval boundaries = %#v", items[0])
	}
	if items[1].ID != "history-excluded" || items[1].State != "excluded" || items[1].ExclusionReason != "missing completeness confirmation" {
		t.Fatalf("excluded interval view = %#v", items[1])
	}
}
