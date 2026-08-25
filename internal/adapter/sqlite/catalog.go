package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

type Service = domain.Service
type ServiceIdentifierMapping = domain.ServiceIdentifierMapping
type LimitDefinition = domain.LimitDefinition
type Plan = domain.Plan
type PlanVersion = domain.PlanVersion
type PlanLimitRule = domain.PlanLimitRule
type StandardPrice = domain.StandardPrice
type IdentificationCandidate = domain.IdentificationCandidate

// CatalogMutation carries the T-020 transaction metadata for a catalog edit.
// The public convenience methods create this metadata when callers do not
// need to choose an audit or recalculation identifier themselves.
type CatalogMutation struct {
	AuditID       string
	RequestID     string
	Actor         string
	Action        string
	EntityType    string
	EntityID      string
	OccurredAt    time.Time
	IntervalStart time.Time
	IntervalEnd   time.Time
}

func (l *Lifecycle) CreateService(ctx context.Context, service Service) error {
	if err := service.Validate(); err != nil {
		return err
	}
	mutation := defaultCatalogMutation("create", "service", service.ID, service.UpdatedAt)
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO services
			(service_id, provider, name, official_key, archived_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		service.ID, service.Provider, service.Name, service.OfficialKey,
		optionalTimeText(service.ArchivedAt), utcText(service.CreatedAt), utcText(service.UpdatedAt)); err != nil {
		return fmt.Errorf("insert service: %w", err)
	}
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, service); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateService(ctx context.Context, service Service) error {
	if err := service.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before Service
	var archived sql.NullString
	var created, updated string
	if err := tx.QueryRowContext(ctx, `SELECT provider, name, official_key, archived_at, created_at, updated_at FROM services WHERE service_id = ?`, service.ID).
		Scan(&before.Provider, &before.Name, &before.OfficialKey, &archived, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("service was not found")
		}
		return fmt.Errorf("read service before update: %w", err)
	}
	before.ID = service.ID
	if archived.Valid {
		value, parseErr := parseUTC(archived.String)
		if parseErr != nil {
			return fmt.Errorf("parse service archive time: %w", parseErr)
		}
		before.ArchivedAt = &value
	}
	before.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse service creation time: %w", err)
	}
	before.UpdatedAt, err = parseUTC(updated)
	if err != nil {
		return fmt.Errorf("parse service update time: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE services SET provider = ?, name = ?, official_key = ?, archived_at = ?, updated_at = ? WHERE service_id = ?`,
		service.Provider, service.Name, service.OfficialKey, optionalTimeText(service.ArchivedAt), utcText(service.UpdatedAt), service.ID)
	if err != nil {
		return fmt.Errorf("update service: %w", err)
	}
	if err := requireOneCatalog(result, "service"); err != nil {
		return err
	}
	mutation := defaultCatalogMutation("update", "service", service.ID, service.UpdatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, service); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ArchiveService(ctx context.Context, serviceID string, archivedAt time.Time) error {
	if strings.TrimSpace(serviceID) == "" || archivedAt.IsZero() {
		return errors.New("service archive has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service archive: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var previous sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT archived_at FROM services WHERE service_id = ?`, serviceID).Scan(&previous); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("service was not found")
		}
		return fmt.Errorf("read service before archive: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE services SET archived_at = ?, updated_at = ? WHERE service_id = ?`, utcText(archivedAt), utcText(archivedAt), serviceID)
	if err != nil {
		return fmt.Errorf("archive service: %w", err)
	}
	if err := requireOneCatalog(result, "service"); err != nil {
		return err
	}
	before := map[string]any{"service_id": serviceID, "archived_at": nil}
	if previous.Valid {
		before["archived_at"] = previous.String
	}
	after := map[string]any{"service_id": serviceID, "archived_at": utcText(archivedAt)}
	mutation := defaultCatalogMutation("archive", "service", serviceID, archivedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service archive: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateServiceIdentifierMapping(ctx context.Context, mapping ServiceIdentifierMapping) error {
	if err := mapping.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service identifier mapping: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO service_identifier_mappings
			(mapping_id, identifier_kind, raw_identifier, service_id, valid_from, valid_to, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, mapping.ID, mapping.Kind, mapping.RawIdentifier, mapping.ServiceID,
		catalogPeriodText(mapping.ValidFrom), optionalCatalogPeriodText(mapping.ValidTo), utcText(mapping.CreatedAt)); err != nil {
		return fmt.Errorf("insert service identifier mapping: %w", err)
	}
	mutation := catalogMutationForPeriod("create", "service_identifier_mapping", mapping.ID, mapping.CreatedAt, mapping.ValidFrom, mapping.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, mapping); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service identifier mapping: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateServiceIdentifierMapping(ctx context.Context, mapping ServiceIdentifierMapping) error {
	if err := mapping.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin service identifier mapping update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before ServiceIdentifierMapping
	var kind, from, created string
	var to sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT mapping_id, identifier_kind, raw_identifier, service_id, valid_from, valid_to, created_at FROM service_identifier_mappings WHERE mapping_id = ?`, mapping.ID).
		Scan(&before.ID, &kind, &before.RawIdentifier, &before.ServiceID, &from, &to, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("service identifier mapping was not found")
		}
		return fmt.Errorf("read mapping before update: %w", err)
	}
	before.Kind = domain.ServiceIdentifierKind(kind)
	before.ValidFrom, err = parseUTC(from)
	if err != nil {
		return fmt.Errorf("parse mapping start: %w", err)
	}
	if to.Valid {
		value, parseErr := parseUTC(to.String)
		if parseErr != nil {
			return fmt.Errorf("parse mapping end: %w", parseErr)
		}
		before.ValidTo = &value
	}
	before.CreatedAt, err = parseUTC(created)
	if err != nil {
		return fmt.Errorf("parse mapping creation time: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE service_identifier_mappings SET identifier_kind = ?, raw_identifier = ?, service_id = ?, valid_from = ?, valid_to = ? WHERE mapping_id = ?`, mapping.Kind, mapping.RawIdentifier, mapping.ServiceID, catalogPeriodText(mapping.ValidFrom), optionalCatalogPeriodText(mapping.ValidTo), mapping.ID); err != nil {
		return fmt.Errorf("update service identifier mapping: %w", err)
	}
	mutation := catalogMutationForPeriod("update", "service_identifier_mapping", mapping.ID, mapping.CreatedAt, mapping.ValidFrom, mapping.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, mapping); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit service identifier mapping update: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateLimitDefinition(ctx context.Context, definition LimitDefinition) error {
	if definition.BillingConfirmation == "" {
		if definition.CycleType == "billing" {
			definition.BillingConfirmation = domain.BillingUnconfirmed
		} else {
			definition.BillingConfirmation = domain.BillingNotApplicable
		}
	}
	if err := definition.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin limit definition: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO limit_definitions
			(limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, archived_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, definition.ID, definition.ServiceID, definition.CycleType,
		definition.Meaning, definition.Unit, definition.BillingConfirmation, optionalTimeText(definition.ArchivedAt),
		utcText(definition.CreatedAt), utcText(definition.UpdatedAt)); err != nil {
		return fmt.Errorf("insert limit definition: %w", err)
	}
	mutation := defaultCatalogMutation("create", "limit_definition", definition.ID, definition.UpdatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, definition); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit limit definition: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateLimitDefinition(ctx context.Context, definition LimitDefinition) error {
	if definition.BillingConfirmation == "" {
		if definition.CycleType == "billing" {
			definition.BillingConfirmation = domain.BillingUnconfirmed
		} else {
			definition.BillingConfirmation = domain.BillingNotApplicable
		}
	}
	if err := definition.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin limit definition update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before LimitDefinition
	var confirmation string
	var archived, created, updated sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT limit_definition_id, service_id, cycle_type, meaning, unit, billing_confirmation, archived_at, created_at, updated_at FROM limit_definitions WHERE limit_definition_id = ?`, definition.ID).
		Scan(&before.ID, &before.ServiceID, &before.CycleType, &before.Meaning, &before.Unit, &confirmation, &archived, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("limit definition was not found")
		}
		return fmt.Errorf("read limit definition before update: %w", err)
	}
	before.BillingConfirmation = domain.BillingConfirmation(confirmation)
	if archived.Valid {
		value, parseErr := parseUTC(archived.String)
		if parseErr != nil {
			return fmt.Errorf("parse limit definition archive time: %w", parseErr)
		}
		before.ArchivedAt = &value
	}
	before.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse limit definition creation time: %w", err)
	}
	before.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse limit definition update time: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE limit_definitions SET service_id = ?, cycle_type = ?, meaning = ?, unit = ?, billing_confirmation = ?, archived_at = ?, updated_at = ? WHERE limit_definition_id = ?`, definition.ServiceID, definition.CycleType, definition.Meaning, definition.Unit, definition.BillingConfirmation, optionalTimeText(definition.ArchivedAt), utcText(definition.UpdatedAt), definition.ID)
	if err != nil {
		return fmt.Errorf("update limit definition: %w", err)
	}
	if err := requireOneCatalog(result, "limit definition"); err != nil {
		return err
	}
	mutation := defaultCatalogMutation("update", "limit_definition", definition.ID, definition.UpdatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, definition); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit limit definition update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ArchiveLimitDefinition(ctx context.Context, definitionID string, archivedAt time.Time) error {
	if strings.TrimSpace(definitionID) == "" || archivedAt.IsZero() {
		return errors.New("limit definition archive has an empty required field")
	}
	definitions, err := l.ListLimitDefinitions(ctx, true)
	if err != nil {
		return err
	}
	for _, definition := range definitions {
		if definition.ID == definitionID {
			definition.ArchivedAt = &archivedAt
			definition.UpdatedAt = archivedAt
			return l.UpdateLimitDefinition(ctx, definition)
		}
	}
	return errors.New("limit definition was not found")
}

func (l *Lifecycle) SetBillingConfirmation(ctx context.Context, definitionID string, confirmation domain.BillingConfirmation, updatedAt time.Time) error {
	if strings.TrimSpace(definitionID) == "" || updatedAt.IsZero() {
		return errors.New("billing confirmation has an empty required field")
	}
	if confirmation != domain.BillingUnconfirmed && confirmation != domain.BillingConfirmed && confirmation != domain.BillingNotApplicable {
		return fmt.Errorf("unknown billing confirmation %q", confirmation)
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin billing confirmation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var previous string
	if err := tx.QueryRowContext(ctx, `SELECT billing_confirmation FROM limit_definitions WHERE limit_definition_id = ?`, definitionID).Scan(&previous); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("limit definition was not found")
		}
		return fmt.Errorf("read billing confirmation before update: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE limit_definitions SET billing_confirmation = ?, updated_at = ? WHERE limit_definition_id = ?`, confirmation, utcText(updatedAt), definitionID)
	if err != nil {
		return fmt.Errorf("update billing confirmation: %w", err)
	}
	if err := requireOneCatalog(result, "limit definition"); err != nil {
		return err
	}
	mutation := defaultCatalogMutation("confirm_billing", "limit_definition", definitionID, updatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation,
		map[string]any{"limit_definition_id": definitionID, "billing_confirmation": previous},
		map[string]any{"limit_definition_id": definitionID, "billing_confirmation": confirmation}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit billing confirmation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreatePlan(ctx context.Context, plan Plan) error {
	if err := plan.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO plans (plan_id, service_id, name, is_baseline, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		plan.ID, plan.ServiceID, plan.Name, plan.IsBaseline, optionalTimeText(plan.ArchivedAt), utcText(plan.CreatedAt), utcText(plan.UpdatedAt)); err != nil {
		return fmt.Errorf("insert plan: %w", err)
	}
	mutation := defaultCatalogMutation("create", "plan", plan.ID, plan.UpdatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, plan); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdatePlan(ctx context.Context, plan Plan) error {
	if err := plan.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before Plan
	var baseline int
	var archived, created, updated sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT plan_id, service_id, name, is_baseline, archived_at, created_at, updated_at FROM plans WHERE plan_id = ?`, plan.ID).
		Scan(&before.ID, &before.ServiceID, &before.Name, &baseline, &archived, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("plan was not found")
		}
		return fmt.Errorf("read plan before update: %w", err)
	}
	before.IsBaseline = baseline != 0
	if archived.Valid {
		value, parseErr := parseUTC(archived.String)
		if parseErr != nil {
			return fmt.Errorf("parse plan archive time: %w", parseErr)
		}
		before.ArchivedAt = &value
	}
	before.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse plan creation time: %w", err)
	}
	before.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse plan update time: %w", err)
	}
	result, err := tx.ExecContext(ctx, `UPDATE plans SET service_id = ?, name = ?, is_baseline = ?, archived_at = ?, updated_at = ? WHERE plan_id = ?`, plan.ServiceID, plan.Name, plan.IsBaseline, optionalTimeText(plan.ArchivedAt), utcText(plan.UpdatedAt), plan.ID)
	if err != nil {
		return fmt.Errorf("update plan: %w", err)
	}
	if err := requireOneCatalog(result, "plan"); err != nil {
		return err
	}
	mutation := defaultCatalogMutation("update", "plan", plan.ID, plan.UpdatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, plan); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ArchivePlan(ctx context.Context, planID string, archivedAt time.Time) error {
	if strings.TrimSpace(planID) == "" || archivedAt.IsZero() {
		return errors.New("plan archive has an empty required field")
	}
	plans, err := l.ListPlans(ctx, "", true)
	if err != nil {
		return err
	}
	for _, plan := range plans {
		if plan.ID == planID {
			plan.ArchivedAt = &archivedAt
			plan.UpdatedAt = archivedAt
			return l.UpdatePlan(ctx, plan)
		}
	}
	return errors.New("plan was not found")
}

func (l *Lifecycle) SetBaselinePlan(ctx context.Context, serviceID, planID string, updatedAt time.Time) error {
	if strings.TrimSpace(serviceID) == "" || strings.TrimSpace(planID) == "" || updatedAt.IsZero() {
		return errors.New("baseline plan has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin baseline plan update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var belongs int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM plans WHERE plan_id = ? AND service_id = ?`, planID, serviceID).Scan(&belongs); err != nil {
		return fmt.Errorf("check baseline plan: %w", err)
	}
	if belongs != 1 {
		return errors.New("plan does not belong to service")
	}
	var previousBaseline sql.NullString
	_ = tx.QueryRowContext(ctx, `SELECT plan_id FROM plans WHERE service_id = ? AND is_baseline = 1`, serviceID).Scan(&previousBaseline)
	if _, err := tx.ExecContext(ctx, `UPDATE plans SET is_baseline = 0, updated_at = ? WHERE service_id = ?`, utcText(updatedAt), serviceID); err != nil {
		return fmt.Errorf("clear baseline plan: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE plans SET is_baseline = 1, updated_at = ? WHERE plan_id = ?`, utcText(updatedAt), planID); err != nil {
		return fmt.Errorf("set baseline plan: %w", err)
	}
	before := map[string]any{"service_id": serviceID, "plan_id": nil}
	if previousBaseline.Valid {
		before["plan_id"] = previousBaseline.String
	}
	after := map[string]string{"service_id": serviceID, "plan_id": planID}
	mutation := defaultCatalogMutation("set_baseline", "plan", planID, updatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit baseline plan update: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreatePlanVersion(ctx context.Context, version PlanVersion) error {
	if err := version.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan version creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO plan_versions (plan_version_id, plan_id, name, valid_from, valid_to, official_source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		version.ID, version.PlanID, version.Name, catalogPeriodText(version.ValidFrom), optionalCatalogPeriodText(version.ValidTo), version.OfficialSourceURL, utcText(version.CreatedAt)); err != nil {
		return fmt.Errorf("insert plan version: %w", err)
	}
	mutation := catalogMutationForPeriod("create", "plan_version", version.ID, version.CreatedAt, version.ValidFrom, version.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, version); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan version creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreatePlanLimitRule(ctx context.Context, rule PlanLimitRule) error {
	if err := rule.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin plan limit rule creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO plan_limit_rules (plan_limit_rule_id, plan_version_id, limit_definition_id, plan_limit, limit_multiplier, official_source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		rule.ID, rule.PlanVersionID, rule.LimitDefinitionID, optionalFloat(rule.Limit), optionalFloat(rule.Multiplier), rule.OfficialSourceURL, utcText(rule.CreatedAt)); err != nil {
		return fmt.Errorf("insert plan limit rule: %w", err)
	}
	mutation := defaultCatalogMutation("create", "plan_limit_rule", rule.ID, rule.CreatedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, rule); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit plan limit rule creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateStandardPrice(ctx context.Context, price StandardPrice) error {
	if err := price.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin standard price creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO standard_prices (standard_price_id, plan_version_id, usd_monthly_per_seat, source_url, valid_from, valid_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		price.ID, price.PlanVersionID, price.USDMonthlyPerSeat, price.SourceURL, catalogPeriodText(price.ValidFrom), optionalCatalogPeriodText(price.ValidTo), utcText(price.CreatedAt)); err != nil {
		return fmt.Errorf("insert standard price: %w", err)
	}
	mutation := catalogMutationForPeriod("create", "standard_price", price.ID, price.CreatedAt, price.ValidFrom, price.ValidTo)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, price); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit standard price creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) CreateIdentificationCandidate(ctx context.Context, candidate IdentificationCandidate) error {
	if candidate.State == "" {
		candidate.State = domain.CandidateUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin identification candidate creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO identification_candidates (candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		candidate.ID, candidate.RawLimitServiceIdentifier, candidate.RawReportedPlanName, candidate.State,
		optionalString(candidate.ServiceID), optionalString(candidate.PlanID), optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt), utcText(candidate.CreatedAt), utcText(candidate.UpdatedAt)); err != nil {
		return fmt.Errorf("insert identification candidate: %w", err)
	}
	mutation := catalogMutationForObservation("create", "identification_candidate", candidate.ID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, nil, candidate); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit identification candidate creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpsertIdentificationCandidate(ctx context.Context, candidate IdentificationCandidate) error {
	requestedID := candidate.ID
	if candidate.ID == "" {
		candidate.ID = uuid.NewString()
	}
	if candidate.State == "" {
		candidate.State = domain.CandidateUnconfirmed
	}
	if err := candidate.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	var existingID string
	if requestedID != "" {
		err = database.QueryRowContext(ctx, `SELECT candidate_id FROM identification_candidates WHERE candidate_id = ? AND raw_limit_service_identifier = ? AND raw_reported_plan_name = ?`, candidate.ID, candidate.RawLimitServiceIdentifier, candidate.RawReportedPlanName).Scan(&existingID)
	} else {
		err = database.QueryRowContext(ctx, `SELECT candidate_id FROM identification_candidates WHERE raw_limit_service_identifier = ? AND raw_reported_plan_name = ? ORDER BY created_at, candidate_id LIMIT 1`, candidate.RawLimitServiceIdentifier, candidate.RawReportedPlanName).Scan(&existingID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		if requestedID != "" {
			return errors.New("candidate ID and raw pair do not match")
		}
		return l.CreateIdentificationCandidate(ctx, candidate)
	}
	if err != nil {
		return fmt.Errorf("find identification candidate: %w", err)
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin identification candidate update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, existingID), &before); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE identification_candidates SET first_observed_at = CASE WHEN first_observed_at IS NULL OR ? < first_observed_at THEN ? ELSE first_observed_at END, last_observed_at = CASE WHEN last_observed_at IS NULL OR ? > last_observed_at THEN ? ELSE last_observed_at END, updated_at = ? WHERE candidate_id = ?`,
		optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.FirstObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt), optionalCatalogPeriodText(candidate.LastObservedAt), utcText(candidate.UpdatedAt), existingID)
	if err != nil {
		return fmt.Errorf("update identification candidate observations: %w", err)
	}
	after := before
	if candidate.FirstObservedAt != nil && (after.FirstObservedAt == nil || candidate.FirstObservedAt.Before(*after.FirstObservedAt)) {
		after.FirstObservedAt = candidate.FirstObservedAt
	}
	if candidate.LastObservedAt != nil && (after.LastObservedAt == nil || candidate.LastObservedAt.After(*after.LastObservedAt)) {
		after.LastObservedAt = candidate.LastObservedAt
	}
	after.UpdatedAt = candidate.UpdatedAt
	mutation := catalogMutationForObservation("update_observations", "identification_candidate", existingID, candidate.UpdatedAt, candidate.FirstObservedAt, candidate.LastObservedAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit identification candidate update: %w", err)
	}
	return nil
}

func (l *Lifecycle) ConfirmIdentificationCandidate(ctx context.Context, candidateID, serviceID, planID string, occurredAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || strings.TrimSpace(serviceID) == "" || strings.TrimSpace(planID) == "" || occurredAt.IsZero() {
		return errors.New("candidate confirmation has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate confirmation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var candidate IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, candidateID), &candidate); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM plans WHERE plan_id = ? AND service_id = ?`, planID, serviceID).Scan(&count); err != nil {
		return fmt.Errorf("check candidate plan service: %w", err)
	}
	if count != 1 {
		return errors.New("candidate plan does not belong to service")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET state = 'confirmed', service_id = ?, plan_id = ?, updated_at = ? WHERE candidate_id = ?`, serviceID, planID, utcText(occurredAt), candidateID); err != nil {
		return fmt.Errorf("confirm identification candidate: %w", err)
	}
	before := candidate
	candidate.State = domain.CandidateConfirmed
	candidate.ServiceID = &serviceID
	candidate.PlanID = &planID
	candidate.UpdatedAt = occurredAt
	mutation := defaultCatalogMutation("confirm", "identification_candidate", candidateID, occurredAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, candidate); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate confirmation: %w", err)
	}
	return nil
}

func (l *Lifecycle) RejectIdentificationCandidate(ctx context.Context, candidateID string, occurredAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || occurredAt.IsZero() {
		return errors.New("candidate rejection has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate rejection: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var candidate IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, candidateID), &candidate); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET state = 'rejected', service_id = NULL, plan_id = NULL, updated_at = ? WHERE candidate_id = ?`, utcText(occurredAt), candidateID); err != nil {
		return fmt.Errorf("reject identification candidate: %w", err)
	}
	before := candidate
	candidate.State = domain.CandidateRejected
	candidate.ServiceID = nil
	candidate.PlanID = nil
	candidate.UpdatedAt = occurredAt
	mutation := defaultCatalogMutation("reject", "identification_candidate", candidateID, occurredAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, candidate); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate rejection: %w", err)
	}
	return nil
}

// ReleaseIdentificationCandidate removes a previous decision and returns the
// pair to the review queue without changing either raw string.
func (l *Lifecycle) ReleaseIdentificationCandidate(ctx context.Context, candidateID string, occurredAt time.Time) error {
	return l.updateIdentificationCandidateState(ctx, candidateID, domain.CandidateUnconfirmed, "release", occurredAt)
}

// UpdateIdentificationCandidate changes the exact raw pair. A correction is
// deliberately made unconfirmed so the new pair cannot silently inherit an
// earlier confirmation.
func (l *Lifecycle) UpdateIdentificationCandidate(ctx context.Context, candidateID, rawLimitIdentifier, rawPlanName string, occurredAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || rawLimitIdentifier == "" || rawPlanName == "" || occurredAt.IsZero() {
		return errors.New("candidate correction has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate correction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, candidateID), &before); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET raw_limit_service_identifier = ?, raw_reported_plan_name = ?, state = 'unconfirmed', service_id = NULL, plan_id = NULL, updated_at = ? WHERE candidate_id = ?`, rawLimitIdentifier, rawPlanName, utcText(occurredAt), candidateID); err != nil {
		return fmt.Errorf("correct identification candidate: %w", err)
	}
	after := before
	after.RawLimitServiceIdentifier = rawLimitIdentifier
	after.RawReportedPlanName = rawPlanName
	after.State = domain.CandidateUnconfirmed
	after.ServiceID = nil
	after.PlanID = nil
	after.UpdatedAt = occurredAt
	mutation := defaultCatalogMutation("correct", "identification_candidate", candidateID, occurredAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate correction: %w", err)
	}
	return nil
}

// SplitIdentificationCandidate creates a separate unconfirmed candidate. Only
// explicitly selected observations move in the same transaction; all other
// evidence stays with the source candidate.
func (l *Lifecycle) SplitIdentificationCandidate(ctx context.Context, candidateID string, split IdentificationCandidate, observationIDs ...string) error {
	if strings.TrimSpace(candidateID) == "" {
		return errors.New("source candidate ID is required")
	}
	split.State = domain.CandidateUnconfirmed
	split.ServiceID = nil
	split.PlanID = nil
	// Bounds are derived from the observations moved below. Caller-provided
	// values are intentionally ignored, including reversed values.
	split.FirstObservedAt = nil
	split.LastObservedAt = nil
	if err := split.Validate(); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate split: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, candidateID), &before); err != nil {
		return err
	}
	if err := validateObservationSelection(tx, candidateID, observationIDs); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO identification_candidates (candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at) VALUES (?, ?, ?, 'unconfirmed', NULL, NULL, NULL, NULL, ?, ?)`,
		split.ID, split.RawLimitServiceIdentifier, split.RawReportedPlanName, utcText(split.CreatedAt), utcText(split.UpdatedAt)); err != nil {
		return fmt.Errorf("insert split candidate: %w", err)
	}
	if len(observationIDs) > 0 {
		placeholders := strings.TrimRight(strings.Repeat("?,", len(observationIDs)), ",")
		args := make([]any, 0, len(observationIDs)+1)
		args = append(args, split.ID)
		for _, id := range observationIDs {
			args = append(args, id)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE identification_candidate_observations SET candidate_id = ? WHERE observation_id IN (`+placeholders+`)`, args...); err != nil {
			return fmt.Errorf("move split candidate observations: %w", err)
		}
	}
	sourceFirst, sourceLast, err := candidateObservationBounds(tx, candidateID)
	if err != nil {
		return err
	}
	newFirst, newLast, err := candidateObservationBounds(tx, split.ID)
	if err != nil {
		return err
	}
	if err := updateCandidateObservationBounds(ctx, tx, candidateID, sourceFirst, sourceLast, split.UpdatedAt); err != nil {
		return err
	}
	if err := updateCandidateObservationBounds(ctx, tx, split.ID, newFirst, newLast, split.UpdatedAt); err != nil {
		return err
	}
	sourceAfter := before
	sourceAfter.FirstObservedAt = sourceFirst
	sourceAfter.LastObservedAt = sourceLast
	sourceAfter.UpdatedAt = split.UpdatedAt
	newAfter := split
	newAfter.FirstObservedAt = newFirst
	newAfter.LastObservedAt = newLast
	newAfter.UpdatedAt = split.UpdatedAt
	mutation := defaultCatalogMutation("split", "identification_candidate", candidateID, split.UpdatedAt)
	setCandidateObservationMutationRange(&mutation, sourceFirst, sourceLast, newFirst, newLast)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, map[string]any{"source_candidate": before, "moved_observation_ids": observationIDs}, map[string]any{"source_candidate": sourceAfter, "new_candidate": newAfter, "moved_observation_ids": observationIDs}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate split: %w", err)
	}
	return nil
}

func candidateObservationBounds(tx *sql.Tx, candidateID string) (*time.Time, *time.Time, error) {
	var first, last sql.NullString
	if err := tx.QueryRow(`SELECT MIN(observed_at), MAX(observed_at) FROM identification_candidate_observations WHERE candidate_id = ?`, candidateID).Scan(&first, &last); err != nil {
		return nil, nil, fmt.Errorf("read candidate observation bounds: %w", err)
	}
	var firstTime, lastTime *time.Time
	if first.Valid {
		value, err := parseUTC(first.String)
		if err != nil {
			return nil, nil, fmt.Errorf("parse candidate first observation: %w", err)
		}
		firstTime = &value
	}
	if last.Valid {
		value, err := parseUTC(last.String)
		if err != nil {
			return nil, nil, fmt.Errorf("parse candidate last observation: %w", err)
		}
		lastTime = &value
	}
	return firstTime, lastTime, nil
}

func updateCandidateObservationBounds(ctx context.Context, tx *sql.Tx, candidateID string, first, last *time.Time, updatedAt time.Time) error {
	result, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET first_observed_at = ?, last_observed_at = ?, updated_at = ? WHERE candidate_id = ?`, optionalCatalogPeriodText(first), optionalCatalogPeriodText(last), utcText(updatedAt), candidateID)
	if err != nil {
		return fmt.Errorf("update candidate observation bounds: %w", err)
	}
	if err := requireOneCatalog(result, "identification candidate"); err != nil {
		return err
	}
	return nil
}

func setCandidateObservationMutationRange(mutation *CatalogMutation, ranges ...*time.Time) {
	var first, last *time.Time
	for index := 0; index+1 < len(ranges); index += 2 {
		start, end := ranges[index], ranges[index+1]
		if start != nil && (first == nil || start.Before(*first)) {
			first = start
		}
		if end != nil && (last == nil || end.After(*last)) {
			last = end
		}
	}
	if first == nil {
		return
	}
	mutation.IntervalStart = *first
	if last != nil {
		value := last.Add(time.Second)
		mutation.IntervalEnd = value
	} else {
		mutation.IntervalEnd = catalogPeriodEnd(nil)
	}
}

func validateObservationSelection(tx *sql.Tx, candidateID string, observationIDs []string) error {
	if len(observationIDs) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(observationIDs))
	for _, id := range observationIDs {
		if strings.TrimSpace(id) == "" {
			return errors.New("split observation ID is required")
		}
		if _, ok := seen[id]; ok {
			return errors.New("split observation IDs must be unique")
		}
		seen[id] = struct{}{}
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(observationIDs)), ",")
	args := make([]any, 0, len(observationIDs)+1)
	args = append(args, candidateID)
	for _, id := range observationIDs {
		args = append(args, id)
	}
	var count int
	if err := tx.QueryRow(`SELECT count(*) FROM identification_candidate_observations WHERE candidate_id = ? AND observation_id IN (`+placeholders+`)`, args...).Scan(&count); err != nil {
		return fmt.Errorf("check split candidate observations: %w", err)
	}
	if count != len(observationIDs) {
		return errors.New("split observations must belong to source candidate")
	}
	return nil
}

func (l *Lifecycle) updateIdentificationCandidateState(ctx context.Context, candidateID string, state domain.CandidateState, action string, occurredAt time.Time) error {
	if strings.TrimSpace(candidateID) == "" || occurredAt.IsZero() {
		return errors.New("candidate state change has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate state change: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var before IdentificationCandidate
	if err := scanCandidate(tx.QueryRowContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, state, service_id, plan_id, first_observed_at, last_observed_at, created_at, updated_at FROM identification_candidates WHERE candidate_id = ?`, candidateID), &before); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET state = ?, service_id = NULL, plan_id = NULL, updated_at = ? WHERE candidate_id = ?`, state, utcText(occurredAt), candidateID); err != nil {
		return fmt.Errorf("update candidate state: %w", err)
	}
	after := before
	after.State = state
	after.ServiceID = nil
	after.PlanID = nil
	after.UpdatedAt = occurredAt
	mutation := defaultCatalogMutation(action, "identification_candidate", candidateID, occurredAt)
	if err := appendCatalogAuditAndRequest(ctx, tx, mutation, before, after); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate state change: %w", err)
	}
	return nil
}

func (l *Lifecycle) AddIdentificationCandidateObservation(ctx context.Context, observationID, candidateID, hubID, accountDisplay string, observedAt time.Time) error {
	if strings.TrimSpace(observationID) == "" || strings.TrimSpace(candidateID) == "" || strings.TrimSpace(hubID) == "" || observedAt.IsZero() {
		return errors.New("candidate observation has an empty required field")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin candidate observation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO identification_candidate_observations (observation_id, candidate_id, hub_id, hub_account_display, observed_at) VALUES (?, ?, ?, ?, ?)`, observationID, candidateID, hubID, accountDisplay, catalogPeriodText(observedAt)); err != nil {
		return fmt.Errorf("insert candidate observation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE identification_candidates SET first_observed_at = CASE WHEN first_observed_at IS NULL OR ? < first_observed_at THEN ? ELSE first_observed_at END, last_observed_at = CASE WHEN last_observed_at IS NULL OR ? > last_observed_at THEN ? ELSE last_observed_at END, updated_at = ? WHERE candidate_id = ?`, catalogPeriodText(observedAt), catalogPeriodText(observedAt), catalogPeriodText(observedAt), catalogPeriodText(observedAt), utcText(observedAt), candidateID); err != nil {
		return fmt.Errorf("update candidate observation bounds: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit candidate observation: %w", err)
	}
	return nil
}

func appendCatalogAuditAndRequest(ctx context.Context, tx *sql.Tx, mutation CatalogMutation, before, after any) error {
	if mutation.AuditID == "" {
		mutation.AuditID = uuid.NewString()
	}
	if mutation.RequestID == "" {
		mutation.RequestID = uuid.NewString()
	}
	if mutation.Actor == "" {
		mutation.Actor = "user"
	}
	if mutation.Action == "" || mutation.EntityType == "" || mutation.EntityID == "" || mutation.OccurredAt.IsZero() {
		return errors.New("catalog mutation has an empty required field")
	}
	if mutation.IntervalStart.IsZero() {
		mutation.IntervalStart = mutation.OccurredAt
	}
	if mutation.IntervalEnd.IsZero() {
		// SQLite stores existing timestamps as RFC3339 text. A one-nanosecond
		// interval can sort backwards when one side has a fractional component
		// and the other does not ("...Z" sorts after "....001Z"). Use a full
		// second for the automatically generated, minimal non-empty interval.
		mutation.IntervalEnd = mutation.IntervalStart.Add(time.Second)
	}
	if !mutation.IntervalStart.Before(mutation.IntervalEnd) {
		return errors.New("catalog mutation interval must be non-empty")
	}
	beforeJSON, err := optionalJSON(before)
	if err != nil {
		return err
	}
	afterJSON, err := optionalJSON(after)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO configuration_audits (audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		mutation.AuditID, utcText(mutation.OccurredAt), mutation.Actor, mutation.Action, mutation.EntityType, mutation.EntityID, beforeJSON, afterJSON); err != nil {
		return fmt.Errorf("append catalog audit: %w", err)
	}
	scope, err := scopeForMutation(ctx, tx, mutation, before, after)
	if err != nil {
		return err
	}
	scopeJSON, err := domain.EncodeRecalculationScope(scope)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO recalculation_requests (request_id, audit_id, requested_at, interval_start, interval_end, scope_json, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
		mutation.RequestID, mutation.AuditID, utcText(mutation.OccurredAt), catalogPeriodText(mutation.IntervalStart), catalogPeriodText(mutation.IntervalEnd), scopeJSON); err != nil {
		return fmt.Errorf("append catalog recalculation request: %w", err)
	}
	return nil
}

func defaultCatalogMutation(action, entityType, entityID string, at time.Time) CatalogMutation {
	return CatalogMutation{AuditID: uuid.NewString(), RequestID: uuid.NewString(), Actor: "user", Action: action, EntityType: "catalog_" + entityType, EntityID: entityID, OccurredAt: at.UTC()}
}

func catalogMutationForPeriod(action, entityType, entityID string, occurredAt, start time.Time, end *time.Time) CatalogMutation {
	mutation := defaultCatalogMutation(action, entityType, entityID, occurredAt)
	mutation.IntervalStart = start
	mutation.IntervalEnd = catalogPeriodEnd(end)
	return mutation
}

func catalogMutationForObservation(action, entityType, entityID string, occurredAt time.Time, first, last *time.Time) CatalogMutation {
	mutation := defaultCatalogMutation(action, entityType, entityID, occurredAt)
	if first != nil {
		mutation.IntervalStart = *first
		if last != nil {
			end := last.Add(time.Second)
			mutation.IntervalEnd = end
		} else {
			mutation.IntervalEnd = catalogPeriodEnd(nil)
		}
	}
	return mutation
}

func catalogPeriodEnd(end *time.Time) time.Time {
	if end != nil {
		return *end
	}
	return time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)
}

func optionalTimeText(value *time.Time) any {
	if value == nil {
		return nil
	}
	return utcText(*value)
}

func catalogPeriodText(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func optionalCatalogPeriodText(value *time.Time) any {
	if value == nil {
		return nil
	}
	return catalogPeriodText(*value)
}

func optionalString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalFloat(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func requireOneCatalog(result interface{ RowsAffected() (int64, error) }, label string) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read affected %s count: %w", label, err)
	}
	if count != 1 {
		return fmt.Errorf("%s was not found", label)
	}
	return nil
}

func scanCandidate(row interface{ Scan(...any) error }, candidate *IdentificationCandidate) error {
	var state string
	var serviceID, planID sql.NullString
	var first, last, created, updated sql.NullString
	if err := row.Scan(&candidate.ID, &candidate.RawLimitServiceIdentifier, &candidate.RawReportedPlanName, &state, &serviceID, &planID, &first, &last, &created, &updated); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("identification candidate was not found: %w", sql.ErrNoRows)
		}
		return fmt.Errorf("scan identification candidate: %w", err)
	}
	candidate.State = domain.CandidateState(state)
	if serviceID.Valid {
		candidate.ServiceID = &serviceID.String
	}
	if planID.Valid {
		candidate.PlanID = &planID.String
	}
	var err error
	if first.Valid {
		value, parseErr := parseUTC(first.String)
		if parseErr != nil {
			return fmt.Errorf("parse candidate first observation: %w", parseErr)
		}
		candidate.FirstObservedAt = &value
	}
	if last.Valid {
		value, parseErr := parseUTC(last.String)
		if parseErr != nil {
			return fmt.Errorf("parse candidate last observation: %w", parseErr)
		}
		candidate.LastObservedAt = &value
	}
	candidate.CreatedAt, err = parseUTC(created.String)
	if err != nil {
		return fmt.Errorf("parse candidate creation time: %w", err)
	}
	candidate.UpdatedAt, err = parseUTC(updated.String)
	if err != nil {
		return fmt.Errorf("parse candidate update time: %w", err)
	}
	return nil
}
