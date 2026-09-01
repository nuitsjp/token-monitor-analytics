package sqlite

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"token-monitor-analytics/internal/domain"
)

const builtinCatalogRevision = "2026-09-02.1"

var builtinServices = []struct {
	Key      string
	Provider string
	Name     string
}{
	{Key: "antigravity", Provider: "Google", Name: "Antigravity"},
	{Key: "claude", Provider: "Anthropic", Name: "Claude"},
	{Key: "codex", Provider: "OpenAI", Name: "Codex"},
	{Key: "copilot", Provider: "GitHub", Name: "GitHub Copilot"},
	{Key: "cursor", Provider: "Cursor", Name: "Cursor"},
	{Key: "grok", Provider: "xAI", Name: "Grok"},
}

var builtinPlans = []struct {
	ProviderKey string
	Reported    string
	Name        string
	SourceURL   string
}{
	{ProviderKey: "codex", Reported: "Pro 5x", Name: "Pro 5x", SourceURL: "https://openai.com/codex/"},
	{ProviderKey: "cursor", Reported: "Pro", Name: "Pro", SourceURL: "https://www.cursor.com/pricing"},
	{ProviderKey: "cursor", Reported: "Pro+", Name: "Pro+", SourceURL: "https://www.cursor.com/pricing"},
	{ProviderKey: "cursor", Reported: "Ultra", Name: "Ultra", SourceURL: "https://www.cursor.com/pricing"},
}

// ReconcileObservedConfiguration fills deterministic gaps only. Existing
// conflicting or user-managed rows are never overwritten.
func (l *Lifecycle) ReconcileObservedConfiguration(ctx context.Context, hubID string, at time.Time) (domain.ReconciliationSummary, error) {
	var summary domain.ReconciliationSummary
	if at.IsZero() {
		return summary, errors.New("reconciliation time is required")
	}
	database, err := l.DB()
	if err != nil {
		return summary, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return summary, fmt.Errorf("begin automatic reconciliation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	serviceIDs := make(map[string]string, len(builtinServices))
	for _, entry := range builtinServices {
		serviceID, created, err := ensureBuiltinService(ctx, tx, entry.Key, entry.Provider, entry.Name, at)
		if err != nil {
			return summary, err
		}
		serviceIDs[entry.Key] = serviceID
		if created {
			summary.ServicesCreated++
		}
		for _, kind := range []domain.ServiceIdentifierKind{domain.UsageCostIdentifier, domain.UsageLimitIdentifier} {
			created, err := ensureBuiltinServiceMapping(ctx, tx, entry.Key, serviceID, kind, at)
			if err != nil {
				return summary, err
			}
			if created {
				summary.MappingsCreated++
			}
		}
	}

	planVersions := make(map[string]string, len(builtinPlans))
	planIDs := make(map[string]string, len(builtinPlans))
	for _, entry := range builtinPlans {
		serviceID := serviceIDs[entry.ProviderKey]
		planID, planCreated, versionID, versionCreated, err := ensureBuiltinPlan(ctx, tx, serviceID, entry.ProviderKey, entry.Reported, entry.Name, entry.SourceURL, at)
		if err != nil {
			return summary, err
		}
		planIDs[entry.ProviderKey+"\x1f"+entry.Reported] = planID
		planVersions[entry.ProviderKey+"\x1f"+entry.Reported] = versionID
		if planCreated {
			summary.PlansCreated++
		}
		if versionCreated {
			summary.PlanVersionsCreated++
		}
	}

	if err := reconcileObservedAccounts(ctx, tx, hubID, at, planIDs, planVersions, &summary); err != nil {
		return summary, err
	}
	if err := reconcileLimitSources(ctx, tx, hubID, at, &summary); err != nil {
		return summary, err
	}
	if err := reconcileCostSources(ctx, tx, hubID, at, &summary); err != nil {
		return summary, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO catalog_state (singleton, catalog_revision, applied_at) VALUES (1, ?, ?)
		ON CONFLICT(singleton) DO UPDATE SET catalog_revision = excluded.catalog_revision, applied_at = excluded.applied_at`, builtinCatalogRevision, utcText(at)); err != nil {
		return summary, fmt.Errorf("record catalog revision: %w", err)
	}
	if summary.Changed() {
		if err := appendReconciliationAudit(ctx, tx, hubID, at, summary); err != nil {
			return summary, err
		}
	}
	if err := tx.Commit(); err != nil {
		return summary, fmt.Errorf("commit automatic reconciliation: %w", err)
	}
	return summary, nil
}

func ensureBuiltinService(ctx context.Context, tx *sql.Tx, key, provider, name string, at time.Time) (string, bool, error) {
	var serviceID string
	err := tx.QueryRowContext(ctx, `SELECT s.service_id FROM service_identifier_mappings m JOIN services s ON s.service_id = m.service_id
		WHERE m.identifier_kind = 'usage_limit' AND m.raw_identifier = ? AND m.valid_to IS NULL ORDER BY m.valid_from DESC LIMIT 1`, key).Scan(&serviceID)
	if err == nil {
		if err := ensureCatalogBinding(ctx, tx, "service", "service:"+key, serviceID, "catalog", at); err != nil {
			return "", false, err
		}
		return serviceID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, fmt.Errorf("find catalog service %s: %w", key, err)
	}
	err = tx.QueryRowContext(ctx, `SELECT service_id FROM services WHERE official_key = ?`, key).Scan(&serviceID)
	if err == nil {
		if err := ensureCatalogBinding(ctx, tx, "service", "service:"+key, serviceID, "catalog", at); err != nil {
			return "", false, err
		}
		return serviceID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, fmt.Errorf("find service official key %s: %w", key, err)
	}
	serviceID = stableReconciliationID("service", key)
	if _, err := tx.ExecContext(ctx, `INSERT INTO services (service_id, provider, name, official_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, serviceID, provider, name, key, utcText(at), utcText(at)); err != nil {
		return "", false, fmt.Errorf("insert catalog service %s: %w", key, err)
	}
	if err := ensureCatalogBinding(ctx, tx, "service", "service:"+key, serviceID, "catalog", at); err != nil {
		return "", false, err
	}
	return serviceID, true, nil
}

func ensureBuiltinServiceMapping(ctx context.Context, tx *sql.Tx, key, serviceID string, kind domain.ServiceIdentifierKind, at time.Time) (bool, error) {
	var existing string
	err := tx.QueryRowContext(ctx, `SELECT mapping_id FROM service_identifier_mappings WHERE identifier_kind = ? AND raw_identifier = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`, kind, key).Scan(&existing)
	if err == nil {
		if err := ensureCatalogBinding(ctx, tx, "service_identifier_mapping", "mapping:"+string(kind)+":"+key, existing, "catalog", at); err != nil {
			return false, err
		}
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("find catalog mapping %s/%s: %w", kind, key, err)
	}
	id := stableReconciliationID("mapping", string(kind), key)
	if _, err := tx.ExecContext(ctx, `INSERT INTO service_identifier_mappings (mapping_id, identifier_kind, raw_identifier, service_id, valid_from, created_at) VALUES (?, ?, ?, ?, ?, ?)`, id, kind, key, serviceID, "2000-01-01T00:00:00Z", utcText(at)); err != nil {
		return false, fmt.Errorf("insert catalog mapping %s/%s: %w", kind, key, err)
	}
	if err := ensureCatalogBinding(ctx, tx, "service_identifier_mapping", "mapping:"+string(kind)+":"+key, id, "catalog", at); err != nil {
		return false, err
	}
	return true, nil
}

func ensureBuiltinPlan(ctx context.Context, tx *sql.Tx, serviceID, providerKey, reported, name, sourceURL string, at time.Time) (string, bool, string, bool, error) {
	planID := stableReconciliationID("plan", providerKey, reported)
	var existing string
	err := tx.QueryRowContext(ctx, `SELECT plan_id FROM plans WHERE service_id = ? AND name = ? ORDER BY created_at, plan_id LIMIT 1`, serviceID, name).Scan(&existing)
	planCreated := false
	if err == nil {
		planID = existing
	} else if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `INSERT INTO plans (plan_id, service_id, name, is_baseline, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`, planID, serviceID, name, utcText(at), utcText(at)); err != nil {
			return "", false, "", false, fmt.Errorf("insert catalog plan %s: %w", name, err)
		}
		planCreated = true
	} else {
		return "", false, "", false, fmt.Errorf("find catalog plan %s: %w", name, err)
	}
	if err := ensureCatalogBinding(ctx, tx, "plan", "plan:"+providerKey+":"+reported, planID, "catalog", at); err != nil {
		return "", false, "", false, err
	}
	versionID := stableReconciliationID("plan-version", providerKey, reported)
	err = tx.QueryRowContext(ctx, `SELECT plan_version_id FROM plan_versions WHERE plan_id = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`, planID).Scan(&existing)
	versionCreated := false
	if err == nil {
		versionID = existing
	} else if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx, `INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, official_source_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`, versionID, planID, name, "2000-01-01T00:00:00Z", sourceURL, utcText(at)); err != nil {
			return "", false, "", false, fmt.Errorf("insert catalog plan version %s: %w", name, err)
		}
		versionCreated = true
	} else {
		return "", false, "", false, fmt.Errorf("find catalog plan version %s: %w", name, err)
	}
	if err := ensureCatalogBinding(ctx, tx, "plan_version", "plan-version:"+providerKey+":"+reported, versionID, "catalog", at); err != nil {
		return "", false, "", false, err
	}
	return planID, planCreated, versionID, versionCreated, nil
}

func ensureCatalogBinding(ctx context.Context, tx *sql.Tx, entityType, catalogKey, entityID, mode string, at time.Time) error {
	id := stableReconciliationID("catalog-binding", entityType, catalogKey)
	if _, err := tx.ExecContext(ctx, `INSERT INTO catalog_bindings (binding_id, entity_type, catalog_key, entity_id, catalog_revision, management_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(entity_type, catalog_key) DO UPDATE SET catalog_revision = excluded.catalog_revision, updated_at = excluded.updated_at
		WHERE catalog_bindings.management_mode <> 'user'`, id, entityType, catalogKey, entityID, builtinCatalogRevision, mode, utcText(at), utcText(at)); err != nil {
		return fmt.Errorf("bind catalog entity %s: %w", catalogKey, err)
	}
	return nil
}

func reconcileObservedAccounts(ctx context.Context, tx *sql.Tx, hubID string, at time.Time, planIDs, planVersions map[string]string, summary *domain.ReconciliationSummary) error {
	query := `SELECT o.hub_id, o.raw_service_identifier, o.account_key, o.provider_updated_at, o.plan_label, m.service_id
		FROM usage_limit_observations o JOIN service_identifier_mappings m ON m.identifier_kind = 'usage_limit' AND m.raw_identifier = o.raw_service_identifier
		 AND m.valid_from <= o.provider_updated_at AND (m.valid_to IS NULL OR o.provider_updated_at < m.valid_to)
		LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
		WHERE o.account_key <> '' AND (nr.state = 'active' OR nr.state IS NULL)`
	args := []any{}
	if strings.TrimSpace(hubID) != "" {
		query += ` AND o.hub_id = ?`
		args = append(args, hubID)
	}
	query += ` ORDER BY o.hub_id, o.raw_service_identifier, o.account_key, o.provider_updated_at, o.observation_id`
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("list observed accounts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	type row struct{ hub, provider, accountKey, first, last, planLabel, planFirst, serviceID string }
	valuesByKey := make(map[string]*row)
	for rows.Next() {
		var hub, provider, accountKey, observedAt, planLabel, serviceID string
		if err := rows.Scan(&hub, &provider, &accountKey, &observedAt, &planLabel, &serviceID); err != nil {
			return fmt.Errorf("scan observed account: %w", err)
		}
		key := hub + "\x1f" + serviceID + "\x1f" + accountKey
		value := valuesByKey[key]
		if value == nil {
			value = &row{hub: hub, provider: provider, accountKey: accountKey, first: observedAt, last: observedAt, serviceID: serviceID}
			valuesByKey[key] = value
		}
		value.last = observedAt
		if planLabel != "" && planLabel != value.planLabel {
			value.planLabel, value.planFirst = planLabel, observedAt
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read observed accounts: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close observed accounts: %w", err)
	}
	values := make([]row, 0, len(valuesByKey))
	for _, value := range valuesByKey {
		values = append(values, *value)
	}
	sort.Slice(values, func(i, j int) bool {
		return values[i].hub+"\x1f"+values[i].provider+"\x1f"+values[i].accountKey < values[j].hub+"\x1f"+values[j].provider+"\x1f"+values[j].accountKey
	})
	for _, value := range values {
		candidateID := stableReconciliationID("hub-account", value.hub, value.serviceID, value.accountKey)
		if _, err := tx.ExecContext(ctx, `INSERT INTO hub_account_candidates (hub_account_candidate_id, hub_id, service_id, account_key, state, first_observed_at, last_observed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?) ON CONFLICT(hub_id, service_id, account_key) DO UPDATE SET
			first_observed_at = MIN(hub_account_candidates.first_observed_at, excluded.first_observed_at),
			last_observed_at = MAX(hub_account_candidates.last_observed_at, excluded.last_observed_at), updated_at = excluded.updated_at`,
			candidateID, value.hub, value.serviceID, value.accountKey, value.first, value.last, value.first, utcText(at)); err != nil {
			return fmt.Errorf("upsert automatic Hub account: %w", err)
		}
		var state string
		var existingCandidateID string
		var logicalID sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT hub_account_candidate_id, state, logical_account_id FROM hub_account_candidates WHERE hub_id = ? AND service_id = ? AND account_key = ?`, value.hub, value.serviceID, value.accountKey).Scan(&existingCandidateID, &state, &logicalID); err != nil {
			return fmt.Errorf("read automatic Hub account: %w", err)
		}
		if state == string(domain.HubAccountCandidateUnconfirmed) {
			accountID := stableReconciliationID("logical-account", value.hub, value.serviceID, value.accountKey)
			result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO logical_accounts (logical_account_id, service_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, accountID, value.serviceID, value.provider+" "+value.accountKey, value.first, utcText(at))
			if err != nil {
				return fmt.Errorf("insert automatic logical account: %w", err)
			}
			if affected, _ := result.RowsAffected(); affected > 0 {
				summary.AccountsCreated++
			}
			if _, err := tx.ExecContext(ctx, `UPDATE hub_account_candidates SET state = 'associated', logical_account_id = ?, updated_at = ? WHERE hub_account_candidate_id = ? AND state = 'unconfirmed'`, accountID, utcText(at), existingCandidateID); err != nil {
				return fmt.Errorf("associate automatic Hub account: %w", err)
			}
			logicalID = sql.NullString{String: accountID, Valid: true}
		}
		if !logicalID.Valid {
			continue
		}
		planKey := value.provider + "\x1f" + value.planLabel
		planID, planResolved := planIDs[planKey]
		versionID := planVersions[planKey]
		if value.planLabel != "" {
			evidence := "plan_label"
			if value.provider == "codex" {
				evidence = "codex_account_label"
			}
			entitlementID := stableReconciliationID("entitlement", value.hub, value.serviceID, value.accountKey, value.planLabel, evidence)
			state, nullablePlan := "unresolved", any(nil)
			if planResolved {
				state, nullablePlan = "resolved", planID
			}
			result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO observed_entitlements (entitlement_id, hub_id, service_id, account_key, reported_plan_name, evidence_source, state, plan_id, first_observed_at, last_observed_at, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entitlementID, value.hub, value.serviceID, value.accountKey, value.planLabel, evidence, state, nullablePlan, value.planFirst, value.last, value.planFirst, utcText(at))
			if err != nil {
				return fmt.Errorf("upsert observed entitlement: %w", err)
			}
			if affected, _ := result.RowsAffected(); affected > 0 {
				summary.EntitlementsObserved++
			}
			if _, err := tx.ExecContext(ctx, `UPDATE observed_entitlements SET last_observed_at = MAX(last_observed_at, ?),
				state = CASE WHEN ? = 'resolved' THEN 'resolved' ELSE state END,
				plan_id = CASE WHEN ? = 'resolved' THEN ? ELSE plan_id END, updated_at = ?
				WHERE hub_id = ? AND service_id = ? AND account_key = ? AND reported_plan_name = ? AND evidence_source = ?`, value.last, state, state, nullablePlan, utcText(at), value.hub, value.serviceID, value.accountKey, value.planLabel, evidence); err != nil {
				return fmt.Errorf("update observed entitlement bounds: %w", err)
			}
		}
		if !planResolved || versionID == "" {
			continue
		}
		var openHistoryID, openVersionID, openFrom string
		historyErr := tx.QueryRowContext(ctx, `SELECT plan_history_id, plan_version_id, valid_from FROM plan_histories WHERE logical_account_id = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`, logicalID.String).Scan(&openHistoryID, &openVersionID, &openFrom)
		if errors.Is(historyErr, sql.ErrNoRows) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, stableReconciliationID("plan-history", logicalID.String, versionID, value.planFirst), logicalID.String, versionID, value.planFirst, utcText(at), utcText(at)); err != nil {
				return fmt.Errorf("insert automatic plan history: %w", err)
			}
			summary.PlanHistoriesCreated++
		} else if historyErr != nil {
			return fmt.Errorf("read automatic plan history: %w", historyErr)
		} else if openVersionID != versionID && openFrom < value.planFirst {
			if _, err := tx.ExecContext(ctx, `UPDATE plan_histories SET valid_to = ?, updated_at = ? WHERE plan_history_id = ?`, value.planFirst, utcText(at), openHistoryID); err != nil {
				return fmt.Errorf("close automatic plan history: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO plan_histories (plan_history_id, logical_account_id, plan_version_id, valid_from, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, stableReconciliationID("plan-history", logicalID.String, versionID, value.planFirst), logicalID.String, versionID, value.planFirst, utcText(at), utcText(at)); err != nil {
				return fmt.Errorf("insert changed automatic plan history: %w", err)
			}
			summary.PlanHistoriesCreated++
		}
		if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET state = 'confirmed', service_id = ?, plan_id = ?, updated_at = ? WHERE raw_limit_service_identifier = ? AND raw_reported_plan_name = ? AND state = 'unconfirmed'`, value.serviceID, planID, utcText(at), value.provider, value.planLabel); err != nil {
			return fmt.Errorf("confirm exact identification candidate: %w", err)
		}
	}
	return nil
}

func reconcileLimitSources(ctx context.Context, tx *sql.Tx, hubID string, at time.Time, summary *domain.ReconciliationSummary) error {
	query := `SELECT s.usage_limit_source_id, s.hub_id, s.raw_service_identifier, s.account_key, s.window_key, s.normalized_kind, s.normalized_metric, s.normalized_label,
		m.service_id, c.logical_account_id, MIN(o.provider_updated_at)
		FROM usage_limit_sources s JOIN service_identifier_mappings m ON m.identifier_kind = 'usage_limit' AND m.raw_identifier = s.raw_service_identifier AND m.valid_to IS NULL
		JOIN hub_account_candidates c ON c.hub_id = s.hub_id AND c.service_id = m.service_id AND c.account_key = s.account_key AND c.state = 'associated'
		JOIN usage_limit_observations o ON o.hub_id = s.hub_id AND o.device_id = s.device_id AND o.raw_service_identifier = s.raw_service_identifier AND o.account_key = s.account_key AND o.window_key = s.window_key
		WHERE NOT EXISTS (SELECT 1 FROM usage_limit_source_links l WHERE l.usage_limit_source_id = s.usage_limit_source_id AND l.valid_to IS NULL)`
	args := []any{}
	if strings.TrimSpace(hubID) != "" {
		query += ` AND s.hub_id = ?`
		args = append(args, hubID)
	}
	query += ` GROUP BY s.usage_limit_source_id ORDER BY s.usage_limit_source_id`
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("list automatic limit links: %w", err)
	}
	defer func() { _ = rows.Close() }()
	type row struct{ sourceID, hub, provider, accountKey, windowKey, kind, metric, label, serviceID, accountID, first string }
	var values []row
	for rows.Next() {
		var value row
		if err := rows.Scan(&value.sourceID, &value.hub, &value.provider, &value.accountKey, &value.windowKey, &value.kind, &value.metric, &value.label, &value.serviceID, &value.accountID, &value.first); err != nil {
			return fmt.Errorf("scan automatic limit link: %w", err)
		}
		values = append(values, value)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read automatic limit links: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close automatic limit links: %w", err)
	}
	for _, value := range values {
		definitionID := stableReconciliationID("limit-definition", value.serviceID, value.windowKey)
		meaning := strings.TrimSpace(value.label)
		if meaning == "" {
			meaning = strings.TrimSpace(value.kind)
		}
		if meaning == "" {
			meaning = "Provider limit"
		}
		cycle := strings.TrimSpace(value.kind)
		if cycle == "" {
			cycle = "provider"
		}
		unit := strings.TrimSpace(value.metric)
		if unit == "" {
			unit = "percent"
		}
		billing := "not_applicable"
		if cycle == "billing" {
			billing = "unconfirmed"
		}
		result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO limit_definitions (limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, definitionID, value.serviceID, cycle, meaning, unit, billing, utcText(at), utcText(at))
		if err != nil {
			return fmt.Errorf("insert observed limit definition: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected > 0 {
			summary.LimitDefinitionsCreated++
		}
		if err := ensureCatalogBinding(ctx, tx, "limit_definition", "observed-limit:"+value.serviceID+":"+value.windowKey, definitionID, "observed", at); err != nil {
			return err
		}
		associationID := stableReconciliationID("limit-link", value.sourceID, value.accountID, definitionID)
		result, err = tx.ExecContext(ctx, `INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, associationID, value.sourceID, value.accountID, definitionID, value.first, utcText(at), utcText(at))
		if err != nil {
			return fmt.Errorf("insert automatic limit association: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected > 0 {
			summary.LimitAssociationsCreated++
		}
	}
	return nil
}

func reconcileCostSources(ctx context.Context, tx *sql.Tx, hubID string, at time.Time, summary *domain.ReconciliationSummary) error {
	query := `SELECT s.usage_cost_source_id, s.hub_id, s.device_id, s.raw_service_identifier, m.service_id, MIN(o.usage_updated_at)
		FROM usage_cost_sources s JOIN service_identifier_mappings m ON m.identifier_kind = 'usage_cost' AND m.raw_identifier = s.raw_service_identifier AND m.valid_to IS NULL
		JOIN usage_cost_observations o ON o.hub_id = s.hub_id AND o.device_id = s.device_id AND o.raw_service_identifier = s.raw_service_identifier
		WHERE 1 = 1`
	args := []any{}
	if strings.TrimSpace(hubID) != "" {
		query += ` AND s.hub_id = ?`
		args = append(args, hubID)
	}
	query += ` GROUP BY s.usage_cost_source_id ORDER BY s.usage_cost_source_id`
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("list automatic cost sources: %w", err)
	}
	defer func() { _ = rows.Close() }()
	type source struct{ id, hub, device, provider, serviceID, first string }
	var sources []source
	for rows.Next() {
		var value source
		if err := rows.Scan(&value.id, &value.hub, &value.device, &value.provider, &value.serviceID, &value.first); err != nil {
			return fmt.Errorf("scan automatic cost source: %w", err)
		}
		sources = append(sources, value)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read automatic cost sources: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close automatic cost sources: %w", err)
	}
	for _, value := range sources {
		accounts, err := readCostSourceAccountIDs(ctx, tx, value.serviceID, value.hub, value.device, value.provider)
		if err != nil {
			return err
		}
		for _, accountID := range accounts {
			associationID := stableReconciliationID("cost-link", value.id, accountID)
			result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM usage_cost_source_account_links WHERE usage_cost_source_id = ? AND logical_account_id = ? AND valid_to IS NULL)`, associationID, value.id, accountID, value.first, utcText(at), utcText(at), value.id, accountID)
			if err != nil {
				return fmt.Errorf("insert automatic cost association: %w", err)
			}
			if affected, _ := result.RowsAffected(); affected > 0 {
				summary.CostAssociationsCreated++
			}
		}
		if len(accounts) == 0 {
			continue
		}
		var missingKeys int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_limit_observations WHERE hub_id = ? AND device_id = ? AND raw_service_identifier = ? AND account_key = ''`, value.hub, value.device, value.provider).Scan(&missingKeys); err != nil {
			return fmt.Errorf("check cost source account completeness: %w", err)
		}
		if missingKeys != 0 {
			continue
		}
		accountsJSON, _ := json.Marshal(accounts)
		completenessID := stableReconciliationID("cost-completeness", value.id)
		result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO usage_cost_source_completeness (completeness_id, usage_cost_source_id, valid_from, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at)
			SELECT ?, ?, ?, 'confirmed', ?, '[]', ?, ? WHERE NOT EXISTS (SELECT 1 FROM usage_cost_source_completeness WHERE usage_cost_source_id = ? AND valid_to IS NULL)`, completenessID, value.id, value.first, string(accountsJSON), utcText(at), utcText(at), value.id)
		if err != nil {
			return fmt.Errorf("confirm automatic cost source completeness: %w", err)
		}
		if affected, _ := result.RowsAffected(); affected > 0 {
			summary.CompletenessConfirmed++
		}
	}
	return nil
}

func readCostSourceAccountIDs(ctx context.Context, tx *sql.Tx, serviceID, hubID, deviceID, provider string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT c.logical_account_id FROM usage_limit_observations o
		JOIN hub_account_candidates c ON c.hub_id = o.hub_id AND c.account_key = o.account_key AND c.service_id = ? AND c.state = 'associated'
		WHERE o.hub_id = ? AND o.device_id = ? AND o.raw_service_identifier = ? AND o.account_key <> '' ORDER BY c.logical_account_id`, serviceID, hubID, deviceID, provider)
	if err != nil {
		return nil, fmt.Errorf("list cost source accounts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var accounts []string
	for rows.Next() {
		var accountID string
		if err := rows.Scan(&accountID); err != nil {
			return nil, fmt.Errorf("scan cost source account: %w", err)
		}
		accounts = append(accounts, accountID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read cost source accounts: %w", err)
	}
	return accounts, nil
}

func appendReconciliationAudit(ctx context.Context, tx *sql.Tx, hubID string, at time.Time, summary domain.ReconciliationSummary) error {
	after, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("encode reconciliation summary: %w", err)
	}
	auditID, requestID := uuid.NewString(), uuid.NewString()
	entityID := strings.TrimSpace(hubID)
	if entityID == "" {
		entityID = "all-hubs"
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id, after_json) VALUES (?, ?, 'system', 'auto_reconcile', 'automatic_reconciliation', ?, ?)`, auditID, utcText(at), entityID, string(after)); err != nil {
		return fmt.Errorf("append reconciliation audit: %w", err)
	}
	serviceIDs, err := readActiveServiceIDs(ctx, tx)
	if err != nil {
		return err
	}
	scope := domain.RecalculationScope{ServiceIDs: serviceIDs}
	scopeJSON, err := domain.EncodeRecalculationScope(scope)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO recalculation_requests (request_id, audit_id, requested_at, interval_start, interval_end, scope_json, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`, requestID, auditID, utcText(at), "2000-01-01T00:00:00Z", catalogPeriodText(at.Add(time.Second)), scopeJSON); err != nil {
		return fmt.Errorf("append reconciliation recalculation request: %w", err)
	}
	return nil
}

func readActiveServiceIDs(ctx context.Context, tx *sql.Tx) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT service_id FROM services WHERE archived_at IS NULL ORDER BY service_id`)
	if err != nil {
		return nil, fmt.Errorf("list reconciliation scope: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var serviceIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan reconciliation scope: %w", err)
		}
		serviceIDs = append(serviceIDs, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read reconciliation scope: %w", err)
	}
	return serviceIDs, nil
}

func stableReconciliationID(prefix string, parts ...string) string {
	values := append([]string{prefix}, parts...)
	sum := sha256.Sum256([]byte(strings.Join(values, "\x1f")))
	return prefix + "-" + hex.EncodeToString(sum[:16])
}
