package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

type UsageCostSource = domain.UsageCostSource
type UsageLimitSource = domain.UsageLimitSource
type UsageCostAssociation = domain.UsageCostAssociation
type UsageLimitAssociation = domain.UsageLimitAssociation
type UsageCostSourceCompleteness = domain.UsageCostSourceCompleteness
type CompletenessState = domain.CompletenessState
type HubSwitch = domain.HubSwitch
type ImpactInterval = domain.ImpactInterval
type ImpactPreview = domain.ImpactPreview

const (
	CompletenessUnconfirmed = domain.CompletenessUnconfirmed
	CompletenessConfirmed   = domain.CompletenessConfirmed
)

var (
	ErrUsageCostSourceNotFound       = errors.New("usage cost source was not found")
	ErrUsageLimitSourceNotFound      = errors.New("usage limit source was not found")
	ErrUsageCostAssociationNotFound  = errors.New("usage cost association was not found")
	ErrUsageLimitAssociationNotFound = errors.New("usage limit association was not found")
	ErrCompletenessNotFound          = errors.New("usage cost source completeness was not found")
	ErrHubSwitchNotFound             = errors.New("Hub switch was not found")
	ErrUsageCostSourceNotEstimable   = errors.New("usage cost source is not estimable for the requested interval")
)

func (l *Lifecycle) CreateUsageCostSource(ctx context.Context, source UsageCostSource) error {
	if err := source.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage cost source creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertUsageCostSourceTx(ctx, tx, source); err != nil {
		return err
	}
	if err := appendCatalogAuditAndRequest(ctx, tx, defaultCatalogMutation("create", "usage_cost_source", source.ID, source.CreatedAt), nil, source); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage cost source creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateUsageLimitSource(ctx context.Context, source UsageLimitSource) error {
	if err := source.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage limit source creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertUsageLimitSourceTx(ctx, tx, source); err != nil {
		return err
	}
	if err := appendCatalogAuditAndRequest(ctx, tx, defaultCatalogMutation("create", "usage_limit_source", source.ID, source.CreatedAt), nil, source); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage limit source creation: %w", err)
	}
	return nil
}

// EnsureUsageCostSource is used by normalization. A repeated observation
// reuses the same immutable source row without producing a configuration edit.
func (l *Lifecycle) EnsureUsageCostSource(ctx context.Context, source UsageCostSource) (UsageCostSource, error) {
	if err := source.Validate(); err != nil {
		return UsageCostSource{}, err
	}
	database, err := l.DB()
	if err != nil {
		return UsageCostSource{}, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return UsageCostSource{}, fmt.Errorf("begin usage cost source ensure: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT (hub_id, device_id, raw_service_identifier) DO NOTHING`,
		source.ID, source.HubID, source.DeviceID, source.RawServiceIdentifier, utcText(source.CreatedAt)); err != nil {
		return UsageCostSource{}, fmt.Errorf("ensure usage cost source: %w", err)
	}
	var result UsageCostSource
	if err := scanUsageCostSource(tx.QueryRowContext(ctx, `SELECT usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at FROM usage_cost_sources WHERE hub_id = ? AND device_id = ? AND raw_service_identifier = ?`, source.HubID, source.DeviceID, source.RawServiceIdentifier), &result); err != nil {
		return UsageCostSource{}, err
	}
	if err := tx.Commit(); err != nil {
		return UsageCostSource{}, fmt.Errorf("commit usage cost source ensure: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) EnsureUsageLimitSource(ctx context.Context, source UsageLimitSource) (UsageLimitSource, error) {
	if err := source.Validate(); err != nil {
		return UsageLimitSource{}, err
	}
	database, err := l.DB()
	if err != nil {
		return UsageLimitSource{}, err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return UsageLimitSource{}, fmt.Errorf("begin usage limit source ensure: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_limit_sources
			(usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key,
			 normalized_kind, normalized_metric, normalized_label, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (hub_id, device_id, raw_service_identifier, account_key, window_key) DO NOTHING`,
		source.ID, source.HubID, source.DeviceID, source.AccountKey, source.RawServiceIdentifier, source.WindowKey,
		source.NormalizedKind, source.NormalizedMetric, source.NormalizedLabel, utcText(source.CreatedAt)); err != nil {
		return UsageLimitSource{}, fmt.Errorf("ensure usage limit source: %w", err)
	}
	var result UsageLimitSource
	if err := scanUsageLimitSource(tx.QueryRowContext(ctx, `SELECT usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at FROM usage_limit_sources WHERE hub_id = ? AND device_id = ? AND raw_service_identifier = ? AND account_key = ? AND window_key = ?`, source.HubID, source.DeviceID, source.RawServiceIdentifier, source.AccountKey, source.WindowKey), &result); err != nil {
		return UsageLimitSource{}, err
	}
	if err := tx.Commit(); err != nil {
		return UsageLimitSource{}, fmt.Errorf("commit usage limit source ensure: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListUsageCostSources(ctx context.Context, hubID string) ([]UsageCostSource, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at FROM usage_cost_sources`
	args := []any{}
	if hubID != "" {
		query += ` WHERE hub_id = ?`
		args = append(args, hubID)
	}
	query += ` ORDER BY hub_id, device_id, raw_service_identifier, usage_cost_source_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list usage cost sources: %w", err)
	}
	defer rows.Close()
	result := make([]UsageCostSource, 0)
	for rows.Next() {
		var source UsageCostSource
		if err := scanUsageCostSource(rows, &source); err != nil {
			return nil, err
		}
		result = append(result, source)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage cost sources: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListUsageLimitSources(ctx context.Context, hubID string) ([]UsageLimitSource, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at FROM usage_limit_sources`
	args := []any{}
	if hubID != "" {
		query += ` WHERE hub_id = ?`
		args = append(args, hubID)
	}
	query += ` ORDER BY hub_id, device_id, raw_service_identifier, account_key, window_key, usage_limit_source_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list usage limit sources: %w", err)
	}
	defer rows.Close()
	result := make([]UsageLimitSource, 0)
	for rows.Next() {
		var source UsageLimitSource
		if err := scanUsageLimitSource(rows, &source); err != nil {
			return nil, err
		}
		result = append(result, source)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage limit sources: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) CreateUsageCostAssociation(ctx context.Context, association UsageCostAssociation) error {
	if err := association.Validate(); err != nil {
		return err
	}
	association.ValidFrom = association.ValidFrom.UTC()
	association.ValidTo = normalizedTimePtr(association.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage cost association creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_cost_source_account_links (usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, association.ID, association.UsageCostSourceID, association.LogicalAccountID, catalogPeriodText(association.ValidFrom), optionalCatalogPeriodText(association.ValidTo), utcText(association.CreatedAt), utcText(association.UpdatedAt)); err != nil {
		return fmt.Errorf("insert usage cost association: %w", err)
	}
	mutation := catalogMutationForPeriod("create", "usage_cost_association", association.ID, association.UpdatedAt, association.ValidFrom, association.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, association); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage cost association creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateUsageLimitAssociation(ctx context.Context, association UsageLimitAssociation) error {
	if err := association.Validate(); err != nil {
		return err
	}
	association.ValidFrom = association.ValidFrom.UTC()
	association.ValidTo = normalizedTimePtr(association.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage limit association creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := validateLimitAssociationServices(ctx, tx, association); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_limit_source_links (usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, association.ID, association.UsageLimitSourceID, association.LogicalAccountID, association.LimitDefinitionID, catalogPeriodText(association.ValidFrom), optionalCatalogPeriodText(association.ValidTo), utcText(association.CreatedAt), utcText(association.UpdatedAt)); err != nil {
		return fmt.Errorf("insert usage limit association: %w", err)
	}
	mutation := catalogMutationForPeriod("create", "usage_limit_association", association.ID, association.UpdatedAt, association.ValidFrom, association.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, association); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage limit association creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateUsageCostAssociation(ctx context.Context, association UsageCostAssociation) error {
	if err := association.Validate(); err != nil {
		return err
	}
	association.ValidFrom = association.ValidFrom.UTC()
	association.ValidTo = normalizedTimePtr(association.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage cost association update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before UsageCostAssociation
	if err := scanUsageCostAssociation(tx.QueryRowContext(ctx, `SELECT usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at FROM usage_cost_source_account_links WHERE usage_cost_association_id = ?`, association.ID), &before); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE usage_cost_source_account_links SET usage_cost_source_id = ?, logical_account_id = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE usage_cost_association_id = ?`, association.UsageCostSourceID, association.LogicalAccountID, catalogPeriodText(association.ValidFrom), optionalCatalogPeriodText(association.ValidTo), utcText(association.UpdatedAt), association.ID)
	if err != nil {
		return fmt.Errorf("update usage cost association: %w", err)
	}
	if err := requireOneCatalog(result, "usage cost association"); err != nil {
		return err
	}
	mutation := catalogMutationForPeriod("update", "usage_cost_association", association.ID, association.UpdatedAt, association.ValidFrom, association.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, association); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage cost association update: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateUsageLimitAssociation(ctx context.Context, association UsageLimitAssociation) error {
	if err := association.Validate(); err != nil {
		return err
	}
	association.ValidFrom = association.ValidFrom.UTC()
	association.ValidTo = normalizedTimePtr(association.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin usage limit association update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before UsageLimitAssociation
	if err := scanUsageLimitAssociation(tx.QueryRowContext(ctx, `SELECT usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at FROM usage_limit_source_links WHERE usage_limit_association_id = ?`, association.ID), &before); err != nil {
		return err
	}
	if err := validateLimitAssociationServices(ctx, tx, association); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE usage_limit_source_links SET usage_limit_source_id = ?, logical_account_id = ?, limit_definition_id = ?, valid_from = ?, valid_to = ?, updated_at = ? WHERE usage_limit_association_id = ?`, association.UsageLimitSourceID, association.LogicalAccountID, association.LimitDefinitionID, catalogPeriodText(association.ValidFrom), optionalCatalogPeriodText(association.ValidTo), utcText(association.UpdatedAt), association.ID)
	if err != nil {
		return fmt.Errorf("update usage limit association: %w", err)
	}
	if err := requireOneCatalog(result, "usage limit association"); err != nil {
		return err
	}
	mutation := catalogMutationForPeriod("update", "usage_limit_association", association.ID, association.UpdatedAt, association.ValidFrom, association.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, association); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage limit association update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListUsageCostAssociations(ctx context.Context, sourceID string) ([]UsageCostAssociation, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT usage_cost_association_id, usage_cost_source_id, logical_account_id, valid_from, valid_to, created_at, updated_at FROM usage_cost_source_account_links`
	args := []any{}
	if sourceID != "" {
		query += ` WHERE usage_cost_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY usage_cost_source_id, valid_from, usage_cost_association_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list usage cost associations: %w", err)
	}
	defer rows.Close()
	result := make([]UsageCostAssociation, 0)
	for rows.Next() {
		var item UsageCostAssociation
		if err := scanUsageCostAssociation(rows, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage cost associations: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ListUsageLimitAssociations(ctx context.Context, sourceID string) ([]UsageLimitAssociation, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT usage_limit_association_id, usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to, created_at, updated_at FROM usage_limit_source_links`
	args := []any{}
	if sourceID != "" {
		query += ` WHERE usage_limit_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY usage_limit_source_id, valid_from, usage_limit_association_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list usage limit associations: %w", err)
	}
	defer rows.Close()
	result := make([]UsageLimitAssociation, 0)
	for rows.Next() {
		var item UsageLimitAssociation
		if err := scanUsageLimitAssociation(rows, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage limit associations: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) CreateUsageCostSourceCompleteness(ctx context.Context, completeness UsageCostSourceCompleteness) error {
	if completeness.State == "" {
		completeness.State = domain.CompletenessUnconfirmed
	}
	if err := completeness.Validate(); err != nil {
		return err
	}
	accountsJSON, excludedJSON, err := completeness.CanonicalJSON()
	if err != nil {
		return err
	}
	completeness.ValidFrom = completeness.ValidFrom.UTC()
	completeness.ValidTo = normalizedTimePtr(completeness.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin source completeness creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := verifyLogicalAccountsTx(ctx, tx, completeness.LogicalAccountIDs); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_cost_source_completeness (completeness_id, usage_cost_source_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, completeness.ID, completeness.UsageCostSourceID, catalogPeriodText(completeness.ValidFrom), optionalCatalogPeriodText(completeness.ValidTo), completeness.State, accountsJSON, excludedJSON, utcText(completeness.CreatedAt), utcText(completeness.UpdatedAt)); err != nil {
		return fmt.Errorf("insert source completeness: %w", err)
	}
	mutation := catalogMutationForPeriod("confirm_completeness", "usage_cost_source_completeness", completeness.ID, completeness.UpdatedAt, completeness.ValidFrom, completeness.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, completeness); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit source completeness creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateUsageCostSourceCompleteness(ctx context.Context, completeness UsageCostSourceCompleteness) error {
	if completeness.State == "" {
		completeness.State = domain.CompletenessUnconfirmed
	}
	if err := completeness.Validate(); err != nil {
		return err
	}
	accountsJSON, excludedJSON, err := completeness.CanonicalJSON()
	if err != nil {
		return err
	}
	completeness.ValidFrom = completeness.ValidFrom.UTC()
	completeness.ValidTo = normalizedTimePtr(completeness.ValidTo)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin source completeness update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before UsageCostSourceCompleteness
	if err := scanCompleteness(tx.QueryRowContext(ctx, `SELECT completeness_id, usage_cost_source_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at FROM usage_cost_source_completeness WHERE completeness_id = ?`, completeness.ID), &before); err != nil {
		return err
	}
	if err := verifyLogicalAccountsTx(ctx, tx, completeness.LogicalAccountIDs); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE usage_cost_source_completeness SET usage_cost_source_id = ?, valid_from = ?, valid_to = ?, state = ?, logical_account_ids_json = ?, excluded_activity_json = ?, updated_at = ? WHERE completeness_id = ?`, completeness.UsageCostSourceID, catalogPeriodText(completeness.ValidFrom), optionalCatalogPeriodText(completeness.ValidTo), completeness.State, accountsJSON, excludedJSON, utcText(completeness.UpdatedAt), completeness.ID)
	if err != nil {
		return fmt.Errorf("update source completeness: %w", err)
	}
	if err := requireOneCatalog(result, "usage cost source completeness"); err != nil {
		return err
	}
	mutation := catalogMutationForPeriod("update_completeness", "usage_cost_source_completeness", completeness.ID, completeness.UpdatedAt, completeness.ValidFrom, completeness.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, completeness); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit source completeness update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListUsageCostSourceCompleteness(ctx context.Context, sourceID string) ([]UsageCostSourceCompleteness, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	query := `SELECT completeness_id, usage_cost_source_id, valid_from, valid_to, state, logical_account_ids_json, excluded_activity_json, created_at, updated_at FROM usage_cost_source_completeness`
	args := []any{}
	if sourceID != "" {
		query += ` WHERE usage_cost_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY usage_cost_source_id, valid_from, completeness_id`
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list source completeness: %w", err)
	}
	defer rows.Close()
	result := make([]UsageCostSourceCompleteness, 0)
	for rows.Next() {
		var item UsageCostSourceCompleteness
		if err := scanCompleteness(rows, &item); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read source completeness: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) ConfirmHubSwitch(ctx context.Context, switchRecord HubSwitch) error {
	if err := switchRecord.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub switch confirmation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO hub_switches (hub_switch_id, old_hub_id, old_device_id, new_hub_id, new_device_id, collection_device_id, switched_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, switchRecord.ID, switchRecord.OldHubID, switchRecord.OldDeviceID, switchRecord.NewHubID, switchRecord.NewDeviceID, switchRecord.CollectionDeviceID, utcText(switchRecord.SwitchedAt), utcText(switchRecord.CreatedAt)); err != nil {
		return fmt.Errorf("insert Hub switch: %w", err)
	}
	mutation := defaultCatalogMutation("confirm_hub_switch", "hub_switch", switchRecord.ID, switchRecord.CreatedAt)
	mutation.IntervalStart = switchRecord.SwitchedAt
	mutation.IntervalEnd = catalogPeriodEnd(nil)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, switchRecord); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub switch confirmation: %w", err)
	}
	return nil
}

func (l *Lifecycle) ListHubSwitches(ctx context.Context) ([]HubSwitch, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `SELECT hub_switch_id, old_hub_id, old_device_id, new_hub_id, new_device_id, collection_device_id, switched_at, created_at FROM hub_switches ORDER BY switched_at, hub_switch_id`)
	if err != nil {
		return nil, fmt.Errorf("list Hub switches: %w", err)
	}
	defer rows.Close()
	result := make([]HubSwitch, 0)
	for rows.Next() {
		var item HubSwitch
		var switched, created string
		if err := rows.Scan(&item.ID, &item.OldHubID, &item.OldDeviceID, &item.NewHubID, &item.NewDeviceID, &item.CollectionDeviceID, &switched, &created); err != nil {
			return nil, fmt.Errorf("scan Hub switch: %w", err)
		}
		item.SwitchedAt, err = parseUTC(switched)
		if err != nil {
			return nil, fmt.Errorf("parse Hub switch time: %w", err)
		}
		item.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse Hub switch creation time: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Hub switches: %w", err)
	}
	return result, nil
}

func (l *Lifecycle) PreviewUsageCostAssociation(ctx context.Context, association UsageCostAssociation) (ImpactPreview, error) {
	return l.previewSource(ctx, association.UsageCostSourceID, "usage_cost", association.ValidFrom, association.ValidTo, `usage_cost_observations o ON o.hub_id = s.hub_id AND o.device_id = s.device_id AND o.raw_service_identifier = s.raw_service_identifier`, `o.usage_updated_at`, `o.observation_id`)
}

func (l *Lifecycle) PreviewUsageLimitAssociation(ctx context.Context, association UsageLimitAssociation) (ImpactPreview, error) {
	return l.previewSource(ctx, association.UsageLimitSourceID, "usage_limit", association.ValidFrom, association.ValidTo, `usage_limit_observations o ON o.hub_id = s.hub_id AND o.device_id = s.device_id AND o.account_key = s.account_key AND o.raw_service_identifier = s.raw_service_identifier AND o.window_key = s.window_key`, `o.provider_updated_at`, `o.observation_id`)
}

// CanUseUsageCostSourceForEstimation rejects the entire requested interval if
// any completeness segment is missing, unconfirmed, excluded, or inconsistent
// with the active cost associations. It never returns a partial interval.
func (l *Lifecycle) CanUseUsageCostSourceForEstimation(ctx context.Context, sourceID string, start, end time.Time) (bool, error) {
	if strings.TrimSpace(sourceID) == "" || start.IsZero() || end.IsZero() || !start.Before(end) {
		return false, errors.New("usage cost source estimation interval is invalid")
	}
	completeness, err := l.ListUsageCostSourceCompleteness(ctx, sourceID)
	if err != nil {
		return false, err
	}
	links, err := l.ListUsageCostAssociations(ctx, sourceID)
	if err != nil {
		return false, err
	}
	cursor := start.UTC()
	for _, item := range completeness {
		item.ValidFrom = item.ValidFrom.UTC()
		item.ValidTo = normalizedTimePtr(item.ValidTo)
		if item.ValidTo != nil && !cursor.Before(*item.ValidTo) {
			continue
		}
		if item.ValidFrom.After(cursor) {
			return false, nil
		}
		segmentEnd := end.UTC()
		if item.ValidTo != nil && item.ValidTo.Before(segmentEnd) {
			segmentEnd = *item.ValidTo
		}
		if !cursor.Before(segmentEnd) {
			continue
		}
		if item.State != domain.CompletenessConfirmed || len(item.ExcludedActivity) != 0 {
			return false, nil
		}
		if err := l.validateCompleteSegment(ctx, sourceID, cursor, segmentEnd, item.LogicalAccountIDs, links); err != nil {
			if errors.Is(err, ErrUsageCostSourceNotEstimable) {
				return false, nil
			}
			return false, err
		}
		cursor = segmentEnd
		if !cursor.Before(end.UTC()) {
			return true, nil
		}
	}
	return false, nil
}

func (l *Lifecycle) previewSource(ctx context.Context, sourceID, kind string, start time.Time, end *time.Time, join, observedColumn, idColumn string) (ImpactPreview, error) {
	if strings.TrimSpace(sourceID) == "" || start.IsZero() {
		return ImpactPreview{}, errors.New("impact preview source and start are required")
	}
	preview := ImpactPreview{SourceID: sourceID, SourceKind: kind, IntervalStart: start.UTC(), IntervalEnd: catalogPeriodEnd(end)}
	database, err := l.DB()
	if err != nil {
		return ImpactPreview{}, err
	}
	query := `SELECT ` + idColumn + `, ` + observedColumn + ` FROM ` + map[string]string{"usage_cost": "usage_cost_sources s", "usage_limit": "usage_limit_sources s"}[kind] + ` JOIN ` + join + ` WHERE s.` + map[string]string{"usage_cost": "usage_cost_source_id", "usage_limit": "usage_limit_source_id"}[kind] + ` = ? AND ` + observedColumn + ` >= ? AND ` + observedColumn + ` < ? AND o.dedupe_state = 'canonical' ORDER BY ` + observedColumn + `, ` + idColumn
	rows, err := database.QueryContext(ctx, query, sourceID, catalogPeriodText(preview.IntervalStart), catalogPeriodText(preview.IntervalEnd))
	if err != nil {
		return ImpactPreview{}, fmt.Errorf("preview source observations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, observed string
		if err := rows.Scan(&id, &observed); err != nil {
			return ImpactPreview{}, fmt.Errorf("scan impact preview observation: %w", err)
		}
		preview.AffectedObservationIDs = append(preview.AffectedObservationIDs, id)
	}
	if err := rows.Err(); err != nil {
		return ImpactPreview{}, fmt.Errorf("read impact preview observations: %w", err)
	}
	if len(preview.AffectedObservationIDs) != 0 {
		preview.AffectedCalculationIntervals = []ImpactInterval{{Start: preview.IntervalStart, End: preview.IntervalEnd}}
	}
	return preview, nil
}

func insertUsageCostSourceTx(ctx context.Context, tx *sql.Tx, source UsageCostSource) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES (?, ?, ?, ?, ?)`, source.ID, source.HubID, source.DeviceID, source.RawServiceIdentifier, utcText(source.CreatedAt)); err != nil {
		return fmt.Errorf("insert usage cost source: %w", err)
	}
	return nil
}

func ensureUsageCostSourceTx(ctx context.Context, tx *sql.Tx, source UsageCostSource) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_cost_sources (usage_cost_source_id, hub_id, device_id, raw_service_identifier, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (hub_id, device_id, raw_service_identifier) DO NOTHING`, source.ID, source.HubID, source.DeviceID, source.RawServiceIdentifier, utcText(source.CreatedAt)); err != nil {
		return fmt.Errorf("ensure usage cost source in observation transaction: %w", err)
	}
	return nil
}

func insertUsageLimitSourceTx(ctx context.Context, tx *sql.Tx, source UsageLimitSource) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, source.ID, source.HubID, source.DeviceID, source.AccountKey, source.RawServiceIdentifier, source.WindowKey, source.NormalizedKind, source.NormalizedMetric, source.NormalizedLabel, utcText(source.CreatedAt)); err != nil {
		return fmt.Errorf("insert usage limit source: %w", err)
	}
	return nil
}

func ensureUsageLimitSourceTx(ctx context.Context, tx *sql.Tx, source UsageLimitSource) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO usage_limit_sources (usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, normalized_kind, normalized_metric, normalized_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hub_id, device_id, raw_service_identifier, account_key, window_key) DO NOTHING`, source.ID, source.HubID, source.DeviceID, source.AccountKey, source.RawServiceIdentifier, source.WindowKey, source.NormalizedKind, source.NormalizedMetric, source.NormalizedLabel, utcText(source.CreatedAt)); err != nil {
		return fmt.Errorf("ensure usage limit source in observation transaction: %w", err)
	}
	if strings.TrimSpace(source.NormalizedKind) == "" || strings.TrimSpace(source.NormalizedMetric) == "" || strings.TrimSpace(source.NormalizedLabel) == "" {
		return nil
	}
	var oldSourceID, oldLabel, oldWindowKey, oldCreatedAt string
	err := tx.QueryRowContext(ctx, `
		SELECT usage_limit_source_id, normalized_label, window_key, created_at
		FROM usage_limit_sources
		WHERE hub_id = ? AND device_id = ? AND account_key = ? AND raw_service_identifier = ?
		  AND window_key = ? AND normalized_kind = ? AND normalized_metric = ?
		  AND normalized_label <> ?
		ORDER BY created_at, usage_limit_source_id LIMIT 1`,
		source.HubID, source.DeviceID, source.AccountKey, source.RawServiceIdentifier,
		source.WindowKey, source.NormalizedKind, source.NormalizedMetric, source.NormalizedLabel).
		Scan(&oldSourceID, &oldLabel, &oldWindowKey, &oldCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read previous usage limit source label: %w", err)
	}
	oldObservedAt, err := parseUTC(oldCreatedAt)
	if err != nil {
		return fmt.Errorf("parse previous usage limit source time: %w", err)
	}
	firstObservedAt, lastObservedAt := oldObservedAt, source.CreatedAt.UTC()
	if lastObservedAt.Before(firstObservedAt) {
		firstObservedAt, lastObservedAt = lastObservedAt, firstObservedAt
	}
	var candidate LimitLabelChangeCandidate
	err = scanLimitLabelChangeCandidate(tx.QueryRowContext(ctx, `
		SELECT candidate_id, hub_id, device_record_key, hub_account_key, raw_limit_service_identifier,
			normalized_kind, normalized_metric, old_label, new_label, state, limit_definition_id,
			first_observed_at, last_observed_at, created_at, updated_at
		FROM limit_label_change_candidates
		WHERE hub_id = ? AND device_record_key = ? AND hub_account_key = ?
		  AND raw_limit_service_identifier = ? AND normalized_kind = ? AND normalized_metric = ?
		  AND old_label = ? AND state = 'unconfirmed'
		ORDER BY created_at, candidate_id LIMIT 1`,
		source.HubID, source.DeviceID, source.AccountKey, source.RawServiceIdentifier,
		source.NormalizedKind, source.NormalizedMetric, oldLabel), &candidate)
	if errors.Is(err, sql.ErrNoRows) {
		candidate = LimitLabelChangeCandidate{
			ID: source.ID, HubID: source.HubID, DeviceRecordKey: source.DeviceID,
			HubAccountKey: source.AccountKey, RawLimitServiceIdentifier: source.RawServiceIdentifier,
			NormalizedKind: source.NormalizedKind, NormalizedMetric: source.NormalizedMetric,
			OldLabel: oldLabel, NewLabel: source.NormalizedLabel, State: domain.LabelChangeUnconfirmed,
			FirstObservedAt: &firstObservedAt, LastObservedAt: &lastObservedAt,
			CreatedAt: source.CreatedAt.UTC(), UpdatedAt: source.CreatedAt.UTC(),
		}
		if err := candidate.Validate(); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO limit_label_change_candidates
				(candidate_id, hub_id, device_record_key, hub_account_key, raw_limit_service_identifier,
				normalized_kind, normalized_metric, old_label, new_label, state, limit_definition_id,
				first_observed_at, last_observed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
			candidate.ID, candidate.HubID, candidate.DeviceRecordKey, candidate.HubAccountKey,
			candidate.RawLimitServiceIdentifier, candidate.NormalizedKind, candidate.NormalizedMetric,
			candidate.OldLabel, candidate.NewLabel, candidate.State,
			optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt),
			utcText(candidate.CreatedAt), utcText(candidate.UpdatedAt)); err != nil {
			return fmt.Errorf("insert observed label change candidate: %w", err)
		}
		if err := appendCatalogAuditAndRequest(ctx, tx, catalogMutationForObservation("observe", "limit_label_change_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt), nil, candidate); err != nil {
			return err
		}
	} else if err != nil {
		return fmt.Errorf("read observed label change candidate: %w", err)
	} else {
		before := candidate
		if candidate.FirstObservedAt == nil || firstObservedAt.Before(*candidate.FirstObservedAt) {
			candidate.FirstObservedAt = &firstObservedAt
		}
		if candidate.LastObservedAt == nil || candidate.LastObservedAt.Before(lastObservedAt) {
			candidate.LastObservedAt = &lastObservedAt
		}
		candidate.NewLabel = source.NormalizedLabel
		candidate.UpdatedAt = source.CreatedAt.UTC()
		if err := candidate.Validate(); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE limit_label_change_candidates SET new_label = ?, first_observed_at = ?, last_observed_at = ?, updated_at = ? WHERE candidate_id = ?`, candidate.NewLabel, optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt), utcText(candidate.UpdatedAt), candidate.ID); err != nil {
			return fmt.Errorf("update observed label change candidate: %w", err)
		}
		if err := appendCatalogAuditAndRequest(ctx, tx, catalogMutationForObservation("observe", "limit_label_change_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt), before, candidate); err != nil {
			return err
		}
	}
	for _, window := range []LimitLabelChangeWindow{
		{ID: candidate.ID + ":old:" + oldSourceID, CandidateID: candidate.ID, WindowKey: oldWindowKey, Label: oldLabel, ObservedAt: oldObservedAt},
		{ID: candidate.ID + ":new:" + source.ID, CandidateID: candidate.ID, WindowKey: source.WindowKey, Label: source.NormalizedLabel, ObservedAt: source.CreatedAt.UTC()},
	} {
		if err := window.Validate(); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO limit_label_change_windows (window_id, candidate_id, window_key, label, observed_at) VALUES (?, ?, ?, ?, ?)`, window.ID, window.CandidateID, window.WindowKey, window.Label, catalogPeriodText(window.ObservedAt)); err != nil {
			return fmt.Errorf("insert observed label change window: %w", err)
		}
	}
	return nil
}

func validateLimitAssociationServices(ctx context.Context, tx *sql.Tx, association UsageLimitAssociation) error {
	var accountService, definitionService string
	if err := tx.QueryRowContext(ctx, `SELECT service_id FROM logical_accounts WHERE logical_account_id = ?`, association.LogicalAccountID).Scan(&accountService); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("logical account was not found")
		}
		return fmt.Errorf("read logical account service: %w", err)
	}
	if err := tx.QueryRowContext(ctx, `SELECT service_id FROM limit_definitions WHERE limit_definition_id = ?`, association.LimitDefinitionID).Scan(&definitionService); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("limit definition was not found")
		}
		return fmt.Errorf("read limit definition service: %w", err)
	}
	if accountService != definitionService {
		return errors.New("logical account and limit definition belong to different services")
	}
	return nil
}

func verifyLogicalAccountsTx(ctx context.Context, tx *sql.Tx, ids []string) error {
	for _, id := range ids {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM logical_accounts WHERE logical_account_id = ?`, id).Scan(&count); err != nil {
			return fmt.Errorf("verify completeness logical account: %w", err)
		}
		if count != 1 {
			return fmt.Errorf("logical account %q was not found", id)
		}
	}
	return nil
}

func (l *Lifecycle) validateCompleteSegment(ctx context.Context, sourceID string, start, end time.Time, expected []string, links []UsageCostAssociation) error {
	actualSet := make(map[string]struct{})
	for _, link := range links {
		if link.ValidFrom.After(start) || !periodContains(link.ValidFrom, link.ValidTo, end) {
			continue
		}
		actualSet[link.LogicalAccountID] = struct{}{}
	}
	expectedSet := make(map[string]struct{}, len(expected))
	for _, id := range expected {
		expectedSet[id] = struct{}{}
		var archived sql.NullString
		database, err := l.DB()
		if err != nil {
			return err
		}
		if err := database.QueryRowContext(ctx, `SELECT archived_at FROM logical_accounts WHERE logical_account_id = ?`, id).Scan(&archived); err != nil {
			return err
		}
		if archived.Valid {
			at, err := parseUTC(archived.String)
			if err != nil {
				return err
			}
			if at.Before(end) {
				return ErrUsageCostSourceNotEstimable
			}
		}
	}
	if len(actualSet) != len(expectedSet) {
		return ErrUsageCostSourceNotEstimable
	}
	for id := range expectedSet {
		if _, ok := actualSet[id]; !ok {
			return ErrUsageCostSourceNotEstimable
		}
	}
	return nil
}

func periodContains(start time.Time, end *time.Time, requiredEnd time.Time) bool {
	return !start.After(requiredEnd) && (end == nil || !end.Before(requiredEnd))
}

func scanUsageCostSource(row rowScanner, source *UsageCostSource) error {
	var created string
	if err := row.Scan(&source.ID, &source.HubID, &source.DeviceID, &source.RawServiceIdentifier, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUsageCostSourceNotFound
		}
		return fmt.Errorf("scan usage cost source: %w", err)
	}
	var err error
	source.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse usage cost source creation time: %w", err)
	}
	return nil
}

func scanUsageLimitSource(row rowScanner, source *UsageLimitSource) error {
	var created string
	if err := row.Scan(&source.ID, &source.HubID, &source.DeviceID, &source.AccountKey, &source.RawServiceIdentifier, &source.WindowKey, &source.NormalizedKind, &source.NormalizedMetric, &source.NormalizedLabel, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUsageLimitSourceNotFound
		}
		return fmt.Errorf("scan usage limit source: %w", err)
	}
	var err error
	source.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse usage limit source creation time: %w", err)
	}
	return nil
}

func scanUsageCostAssociation(row rowScanner, association *UsageCostAssociation) error {
	var from, created, updated string
	var nullableTo sql.NullString
	if err := row.Scan(&association.ID, &association.UsageCostSourceID, &association.LogicalAccountID, &from, &nullableTo, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUsageCostAssociationNotFound
		}
		return fmt.Errorf("scan usage cost association: %w", err)
	}
	var err error
	association.ValidFrom, err = parseUTC(from)
	if err != nil {
		return fmt.Errorf("parse usage cost association start: %w", err)
	}
	if nullableTo.Valid {
		value, parseErr := parseUTC(nullableTo.String)
		if parseErr != nil {
			return fmt.Errorf("parse usage cost association end: %w", parseErr)
		}
		association.ValidTo = &value
	}
	association.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse usage cost association creation time: %w", err)
	}
	association.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return fmt.Errorf("parse usage cost association update time: %w", err)
	}
	return nil
}

func scanUsageLimitAssociation(row rowScanner, association *UsageLimitAssociation) error {
	var from, created, updated string
	var to sql.NullString
	if err := row.Scan(&association.ID, &association.UsageLimitSourceID, &association.LogicalAccountID, &association.LimitDefinitionID, &from, &to, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUsageLimitAssociationNotFound
		}
		return fmt.Errorf("scan usage limit association: %w", err)
	}
	var err error
	association.ValidFrom, err = parseUTC(from)
	if err != nil {
		return fmt.Errorf("parse usage limit association start: %w", err)
	}
	if to.Valid {
		value, parseErr := parseUTC(to.String)
		if parseErr != nil {
			return fmt.Errorf("parse usage limit association end: %w", parseErr)
		}
		association.ValidTo = &value
	}
	association.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse usage limit association creation time: %w", err)
	}
	association.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return fmt.Errorf("parse usage limit association update time: %w", err)
	}
	return nil
}

func scanCompleteness(row rowScanner, item *UsageCostSourceCompleteness) error {
	var from, created, updated, state, accountsJSON, excludedJSON string
	var to sql.NullString
	if err := row.Scan(&item.ID, &item.UsageCostSourceID, &from, &to, &state, &accountsJSON, &excludedJSON, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrCompletenessNotFound
		}
		return fmt.Errorf("scan source completeness: %w", err)
	}
	var err error
	item.ValidFrom, err = parseUTC(from)
	if err != nil {
		return fmt.Errorf("parse source completeness start: %w", err)
	}
	if to.Valid {
		value, parseErr := parseUTC(to.String)
		if parseErr != nil {
			return fmt.Errorf("parse source completeness end: %w", parseErr)
		}
		item.ValidTo = &value
	}
	if err := json.Unmarshal([]byte(accountsJSON), &item.LogicalAccountIDs); err != nil {
		return fmt.Errorf("decode completeness accounts: %w", err)
	}
	if err := json.Unmarshal([]byte(excludedJSON), &item.ExcludedActivity); err != nil {
		return fmt.Errorf("decode completeness exclusions: %w", err)
	}
	item.State = domain.CompletenessState(state)
	item.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse source completeness creation time: %w", err)
	}
	item.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return fmt.Errorf("parse source completeness update time: %w", err)
	}
	return nil
}
