package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestListReviewItemsAggregatesWarningsAndKeepsFilteredCursorStable(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	insertReviewHub(t, database, "hub-1", now)
	if _, err := database.Exec(`INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cost-1', 'hub-1', 'device-1', 'cost.raw', ?), ('cost-2', 'hub-1', 'device-2', 'cost.other', ?)`, utcText(now), utcText(now.Add(time.Minute))); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('limit-1', 'hub-1', 'device-1', '', 'limit.raw', 'window-1', 'window', 'percent', 'label', ?), ('limit-2', 'hub-1', 'device-2', '', 'limit.other', 'window-1', 'window', 'percent', 'label', ?)`, utcText(now), utcText(now.Add(time.Minute))); err != nil {
		t.Fatal(err)
	}
	insertReviewObservationParents(t, database, now)
	insertReviewLimitObservation(t, database, "limit-observation-1", "hub-1", "device-1", "limit.raw", now.Add(10*time.Minute), "conflict")
	insertReviewLimitObservation(t, database, "limit-observation-2", "hub-1", "device-1", "limit.raw", now.Add(20*time.Minute), "conflict")
	insertReviewLimitObservation(t, database, "limit-observation-3", "hub-1", "device-2", "limit.other", now.Add(30*time.Minute), "canonical")
	insertReviewCostObservation(t, database, "cost-observation-1", "hub-1", "device-1", "cost.raw", now.Add(15*time.Minute), "conflict")
	insertReviewCostObservation(t, database, "cost-observation-2", "hub-1", "device-1", "cost.raw", now.Add(25*time.Minute), "conflict")

	page, err := lifecycle.ListReviewItems(ctx, domain.ReviewFilter{Kind: domain.ReviewKindMissingAccountKey, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !page.HasMore || page.Items[0].Count != 1 {
		t.Fatalf("missing account-key page = %#v", page)
	}
	if page.Items[0].Impact != domain.ReviewImpactCalculationIntervalImpossible {
		t.Fatalf("missing account-key impact = %q", page.Items[0].Impact)
	}
	second, err := lifecycle.ListReviewItems(ctx, domain.ReviewFilter{Kind: domain.ReviewKindMissingAccountKey, Limit: 1, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 1 || second.Items[0].Count != 2 || second.HasMore {
		t.Fatalf("cursor crossed filtered boundary: %#v", second)
	}

	from, to := now.Add(5*time.Minute), now.Add(31*time.Minute)
	filtered, err := lifecycle.ListReviewItems(ctx, domain.ReviewFilter{Kind: domain.ReviewKindMissingAccountKey, From: &from, To: &to, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered.Items) != 1 || !filtered.HasMore || filtered.Items[0].Count != 1 || !filtered.Items[0].LastObservedAt.Equal(now.Add(30*time.Minute)) {
		t.Fatalf("date-filtered first page = %#v", filtered)
	}
	filteredNext, err := lifecycle.ListReviewItems(ctx, domain.ReviewFilter{Kind: domain.ReviewKindMissingAccountKey, From: &from, To: &to, Limit: 1, Cursor: filtered.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(filteredNext.Items) != 1 || filteredNext.HasMore || filteredNext.Items[0].Count != 2 || !filteredNext.Items[0].LastObservedAt.Equal(now.Add(20*time.Minute)) {
		t.Fatalf("date-filtered cursor page = %#v", filteredNext)
	}

	from, to = now.Add(15*time.Minute), now.Add(26*time.Minute)
	conflict, err := lifecycle.ListReviewItems(ctx, domain.ReviewFilter{Kind: domain.ReviewKindCostDedupeConflict, From: &from, To: &to, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(conflict.Items) != 1 || conflict.Items[0].Count != 2 || !conflict.Items[0].LastObservedAt.Equal(now.Add(25*time.Minute)) {
		t.Fatalf("date-filtered conflict = %#v", conflict)
	}
}

func TestListReviewItemsClassifiesCanonicalReviewRowsWithoutHubSwitchCandidates(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC)
	insertReviewHub(t, database, "hub-2", now)
	if _, err := database.Exec(`INSERT INTO identification_candidates (candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, first_observed_at, last_observed_at, created_at, updated_at) VALUES ('candidate-1', 'provider.raw', 'Plan A', 'unconfirmed', ?, ?, ?, ?)`, utcText(now), utcText(now.Add(time.Hour)), utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('service-review', 'Provider', 'Service', 'official.review', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('billing-review', 'service-review', 'billing', 'Monthly', 'percent', 'unconfirmed', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	page, err := lifecycle.ListReviewItems(context.Background(), domain.ReviewFilter{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	hasCandidate, hasBilling, hasHubSwitch := false, false, false
	for _, item := range page.Items {
		switch item.Kind {
		case domain.ReviewKindIdentificationCandidate:
			hasCandidate = item.RawLimitServiceIdentifier == "provider.raw" && item.RawReportedPlanName == "Plan A"
		case domain.ReviewKindBillingMonthly:
			hasBilling = true
		case domain.ReviewKind("hub_switch"):
			hasHubSwitch = true
		}
	}
	if !hasCandidate || !hasBilling || hasHubSwitch {
		t.Fatalf("review classifications candidate=%v billing=%v hubSwitch=%v items=%#v", hasCandidate, hasBilling, hasHubSwitch, page.Items)
	}
}

func TestListReviewItemsIncludesCurrentLimitAssociationAndPlanPeriod(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	insertReviewHub(t, database, "hub-current", now)
	if _, err := database.Exec(`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('service-current', 'Provider', 'Service', 'official.current', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('account-current', 'service-current', 'Logical account', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES ('plan-current', 'service-current', 'Plan', 1, ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, valid_to, official_source_url, created_at) VALUES ('version-current', 'plan-current', 'Plan v1', ?, ?, 'https://example.test/plan', ?)`, utcText(now.Add(-time.Hour)), utcText(now.Add(2*time.Hour)), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES ('limit-definition-current', 'service-current', 'window', 'Input limit', 'percent', 'not_applicable', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES ('limit-source-current', 'hub-current', 'device-current', 'account-key', 'limit.current', 'window-current', 'window', 'percent', 'Limit', ?)`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at) VALUES ('limit-association-current', 'limit-source-current', 'account-current', 'limit-definition-current', ?, ?, ?, ?)`, utcText(now.Add(-2*time.Hour)), utcText(now.Add(4*time.Hour)), utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, valid_to, created_at, updated_at) VALUES ('history-current', 'account-current', 'version-current', ?, ?, ?, ?)`, utcText(now.Add(-time.Hour)), utcText(now.Add(2*time.Hour)), utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds) VALUES ('review-attempt-current', 'hub-current', 'manual', 'succeeded', ?, 300)`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body) VALUES ('review-snapshot-current', 'review-attempt-current', 'hub-current', 'stats', ?, ?, 200, ?)`, utcText(now), utcText(now), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('limit-observation-current', 'review-snapshot-current', 'hub-current', 'device-current', 'limit.current', 'account-key', ?, 'window-current', 'window', 'percent', 'Limit', 'Reported plan', 300, 1, 'rule', 'logic', '$.limit', 'canonical', 'dedupe-current', 'fingerprint-current')`, utcText(now)); err != nil {
		t.Fatal(err)
	}

	page, err := lifecycle.ListReviewItems(context.Background(), domain.ReviewFilter{Kind: domain.ReviewKindPlanHistoryInconsistency, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("plan history review items = %#v", page.Items)
	}
	association := page.Items[0].CurrentAssociation
	if association == nil || association.LogicalAccountDisplayName != "Logical account" || association.LimitMeaning != "Input limit" || association.PlanVersionName != "Plan v1" {
		t.Fatalf("current association = %#v", association)
	}
	if association.AssociationValidFrom == nil || association.AssociationValidTo == nil || association.PlanValidFrom == nil || association.PlanValidTo == nil || !association.AssociationValidFrom.Equal(now.Add(-2*time.Hour)) || !association.AssociationValidTo.Equal(now.Add(4*time.Hour)) || !association.PlanValidFrom.Equal(now.Add(-time.Hour)) || !association.PlanValidTo.Equal(now.Add(2*time.Hour)) {
		t.Fatalf("association periods were overwritten: %#v", association)
	}
}

func TestListReviewItemsUsesCostAssociationForCompleteness(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	database, err := lifecycle.DB()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC)
	insertReviewHub(t, database, "hub-cost-current", now)
	if _, err := database.Exec(`INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES ('service-cost-current', 'Provider', 'Cost Service', 'official.cost.current', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES ('account-cost-current', 'service-cost-current', 'Cost logical account', ?, ?)`, utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES ('cost-source-current', 'hub-cost-current', 'device-cost-current', 'cost.current', ?)`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at) VALUES ('cost-association-current', 'cost-source-current', 'account-cost-current', ?, ?, ?, ?)`, utcText(now.Add(-time.Hour)), utcText(now.Add(3*time.Hour)), utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_cost_source_completeness (completeness_id, usage_cost_source_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at) VALUES ('completeness-cost-current', 'cost-source-current', ?, ?, 'unconfirmed', '[]', '[]', ?, ?)`, utcText(now.Add(-time.Hour)), utcText(now.Add(2*time.Hour)), utcText(now), utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds) VALUES ('review-attempt-cost-current', 'hub-cost-current', 'manual', 'succeeded', ?, 300)`, utcText(now)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body) VALUES ('review-snapshot-cost-current', 'review-attempt-cost-current', 'hub-cost-current', 'stats', ?, ?, 200, ?)`, utcText(now), utcText(now), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES ('cost-observation-current', 'review-snapshot-cost-current', 'hub-cost-current', 'device-cost-current', 'cost.current', ?, '1', 300, 1, 'rule', 'logic', '$.cost', 'canonical', 'cost-dedupe-current', 'cost-fingerprint-current')`, utcText(now)); err != nil {
		t.Fatal(err)
	}

	page, err := lifecycle.ListReviewItems(context.Background(), domain.ReviewFilter{Kind: domain.ReviewKindCompleteness, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range page.Items {
		if item.CurrentAssociation != nil && item.CurrentAssociation.LogicalAccountDisplayName == "Cost logical account" {
			found = true
		}
	}
	if !found {
		t.Fatalf("cost completeness association = %#v", page.Items)
	}
}

func insertReviewHub(t *testing.T, database *sql.DB, hubID string, now time.Time) {
	t.Helper()
	// This helper is kept local to the adapter package so review tests do not
	// need a production write path or any additional test-only API.
	_, err := database.Exec(`INSERT INTO hubs (hub_id, display_name, url, collection_enabled, collection_interval_seconds, created_at, updated_at) VALUES (?, 'Review Hub', 'https://hub.example', 1, 300, ?, ?)`, hubID, utcText(now), utcText(now))
	if err != nil {
		t.Fatal(err)
	}
}

func insertReviewObservationParents(t *testing.T, database *sql.DB, now time.Time) {
	t.Helper()
	_, err := database.Exec(`INSERT INTO collection_attempts (attempt_id, hub_id, trigger, state, started_at, analytics_interval_seconds) VALUES ('review-attempt', 'hub-1', 'manual', 'succeeded', ?, 300)`, utcText(now))
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Exec(`INSERT INTO raw_snapshots (snapshot_id, attempt_id, hub_id, response_kind, received_started_at, received_completed_at, http_status, body) VALUES ('review-snapshot', 'review-attempt', 'hub-1', 'stats', ?, ?, 200, ?)`, utcText(now), utcText(now), []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
}

func insertReviewLimitObservation(t *testing.T, database *sql.DB, id, hubID, deviceID, raw string, observed time.Time, state string) {
	t.Helper()
	_, err := database.Exec(`INSERT INTO usage_limit_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, account_key, provider_updated_at, window_key, normalized_kind, normalized_metric, normalized_label, plan_label, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES (?, 'review-snapshot', ?, ?, ?, '', ?, 'window-1', 'window', 'percent', 'label', 'Plan', 300, 1, 'rule', 'logic', '$.limit', ?, ?, ?)`, id, hubID, deviceID, raw, utcText(observed), state, "dedupe-"+id, "fingerprint-"+id)
	if err != nil {
		t.Fatal(err)
	}
}

func insertReviewCostObservation(t *testing.T, database *sql.DB, id, hubID, deviceID, raw string, observed time.Time, state string) {
	t.Helper()
	_, err := database.Exec(`INSERT INTO usage_cost_observations (observation_id, snapshot_id, hub_id, device_id, raw_service_identifier, usage_updated_at, cost_usd_text, analytics_interval_seconds, normalization_generation, normalization_rule_version, normalization_logic_version, json_path, dedupe_state, dedupe_key, value_fingerprint) VALUES (?, 'review-snapshot', ?, ?, ?, ?, '1', 300, 1, 'rule', 'logic', '$.cost', ?, ?, ?)`, id, hubID, deviceID, raw, utcText(observed), state, "cost-dedupe-"+id, "cost-fingerprint-"+id)
	if err != nil {
		t.Fatal(err)
	}
}
