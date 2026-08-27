package sqlite

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

const (
	defaultReviewPageSize = 50
	maxReviewPageSize     = 200
)

type reviewCursor struct {
	LastObservedAt string `json:"lastObservedAt"`
	ID             string `json:"id"`
}

type reviewSourceKey struct {
	HubID                string
	DeviceID             string
	RawServiceIdentifier string
	AccountKey           string
	WindowKey            string
}

type reviewObservation struct {
	ID                   string
	HubID                string
	DeviceID             string
	RawServiceIdentifier string
	AccountKey           string
	WindowKey            string
	PlanLabel            string
	ObservedAt           time.Time
	DedupeState          string
}

type reviewSource struct {
	ID                   string
	HubID                string
	DeviceID             string
	RawServiceIdentifier string
	AccountKey           string
	WindowKey            string
	CreatedAt            time.Time
}

type reviewPeriod struct {
	First time.Time
	Last  time.Time
}

// ListReviewItems derives the M04 read-only list from canonical tables. No
// review queue is persisted: the current source state is the queue.
func (l *Lifecycle) ListReviewItems(ctx context.Context, filter domain.ReviewFilter) (domain.ReviewPage, error) {
	if l == nil {
		return domain.ReviewPage{}, errors.New("review lifecycle is unavailable")
	}
	if err := filter.Validate(); err != nil {
		return domain.ReviewPage{}, err
	}
	cursor, hasCursor, err := decodeReviewCursor(filter.Cursor)
	if err != nil {
		return domain.ReviewPage{}, err
	}
	items, err := l.deriveReviewItems(ctx)
	if err != nil {
		return domain.ReviewPage{}, err
	}
	items = filterReviewItems(items, filter)
	sort.Slice(items, func(i, j int) bool {
		if items[i].LastObservedAt.Equal(items[j].LastObservedAt) {
			return items[i].ID > items[j].ID
		}
		return items[i].LastObservedAt.After(items[j].LastObservedAt)
	})
	if hasCursor {
		cursorTime, err := time.Parse(time.RFC3339Nano, cursor.LastObservedAt)
		if err != nil {
			return domain.ReviewPage{}, errors.New("invalid review cursor")
		}
		cursorTime = cursorTime.UTC()
		start := 0
		for start < len(items) {
			item := items[start]
			if item.LastObservedAt.Before(cursorTime) || (item.LastObservedAt.Equal(cursorTime) && item.ID < cursor.ID) {
				break
			}
			start++
		}
		items = items[start:]
	}
	limit := filter.Limit
	if limit == 0 {
		limit = defaultReviewPageSize
	}
	if limit > maxReviewPageSize {
		limit = maxReviewPageSize
	}
	page := domain.ReviewPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.HasMore = true
		page.NextCursor, err = encodeReviewCursor(reviewCursor{
			LastObservedAt: page.Items[len(page.Items)-1].LastObservedAt.UTC().Format(time.RFC3339Nano),
			ID:             page.Items[len(page.Items)-1].ID,
		})
		if err != nil {
			return domain.ReviewPage{}, err
		}
	}
	return page, nil
}

func filterReviewItems(items []domain.ReviewItem, filter domain.ReviewFilter) []domain.ReviewItem {
	result := make([]domain.ReviewItem, 0, len(items))
	for _, item := range items {
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.State != "" && item.State != filter.State {
			continue
		}
		if filter.Impact != "" && item.Impact != filter.Impact {
			continue
		}
		if filter.HubID != "" && item.HubID != filter.HubID {
			continue
		}
		if filter.From != nil && item.LastObservedAt.Before(filter.From.UTC()) {
			continue
		}
		if filter.To != nil && !item.LastObservedAt.Before(filter.To.UTC()) {
			continue
		}
		result = append(result, item)
	}
	return result
}

func encodeReviewCursor(cursor reviewCursor) (string, error) {
	if cursor.ID == "" || cursor.LastObservedAt == "" {
		return "", errors.New("review cursor requires an item boundary")
	}
	value, err := json.Marshal(cursor)
	if err != nil {
		return "", fmt.Errorf("encode review cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func decodeReviewCursor(value string) (reviewCursor, bool, error) {
	if value == "" {
		return reviewCursor{}, false, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return reviewCursor{}, false, errors.New("invalid review cursor")
	}
	var cursor reviewCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.ID == "" || cursor.LastObservedAt == "" {
		return reviewCursor{}, false, errors.New("invalid review cursor")
	}
	if _, err := time.Parse(time.RFC3339Nano, cursor.LastObservedAt); err != nil {
		return reviewCursor{}, false, errors.New("invalid review cursor")
	}
	return cursor, true, nil
}

func (l *Lifecycle) deriveReviewItems(ctx context.Context) ([]domain.ReviewItem, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	items := make([]domain.ReviewItem, 0)
	appendItems := func(values ...domain.ReviewItem) error {
		for _, value := range values {
			if err := value.Validate(); err != nil {
				return err
			}
			value.EvidenceIDs = append([]string(nil), value.EvidenceIDs...)
			items = append(items, value)
		}
		return nil
	}

	costSources, err := readReviewSources(ctx, database, true)
	if err != nil {
		return nil, err
	}
	limitSources, err := readReviewSources(ctx, database, false)
	if err != nil {
		return nil, err
	}
	costObservations, err := readReviewObservations(ctx, database, true)
	if err != nil {
		return nil, err
	}
	limitObservations, err := readReviewObservations(ctx, database, false)
	if err != nil {
		return nil, err
	}
	costPeriods := reviewObservationPeriods(costObservations)
	limitPeriods := reviewObservationPeriods(limitObservations)
	costLinks, err := readReviewCostLinks(ctx, database)
	if err != nil {
		return nil, err
	}
	limitLinks, err := readReviewLimitLinks(ctx, database)
	if err != nil {
		return nil, err
	}
	logicalAccountNames, err := readReviewLogicalAccountNames(ctx, database)
	if err != nil {
		return nil, err
	}
	limitMeanings, err := readReviewLimitMeanings(ctx, database)
	if err != nil {
		return nil, err
	}
	histories, err := readReviewPlanHistories(ctx, database)
	if err != nil {
		return nil, err
	}
	versions, err := readReviewPlanVersions(ctx, database)
	if err != nil {
		return nil, err
	}

	associatedCost, err := readAssociatedReviewSources(ctx, database, true)
	if err != nil {
		return nil, err
	}
	for _, source := range costSources {
		if _, ok := associatedCost[source.ID]; ok {
			continue
		}
		period := costPeriods[reviewSourceKey{HubID: source.HubID, DeviceID: source.DeviceID, RawServiceIdentifier: source.RawServiceIdentifier}]
		if period.First.IsZero() {
			period = reviewPeriod{First: source.CreatedAt, Last: source.CreatedAt}
		}
		if err := appendItems(newReviewItem("cost:"+source.ID, domain.ReviewKindUsageCostUnassociated, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, source.HubID, source.ID, source.ID, source.RawServiceIdentifier, period, "cost source has no logical-account association", nil)); err != nil {
			return nil, err
		}
	}
	associatedLimit, err := readAssociatedReviewSources(ctx, database, false)
	if err != nil {
		return nil, err
	}
	for _, source := range limitSources {
		if _, ok := associatedLimit[source.ID]; ok {
			continue
		}
		period := limitPeriods[reviewSourceKey{HubID: source.HubID, DeviceID: source.DeviceID, RawServiceIdentifier: source.RawServiceIdentifier, AccountKey: source.AccountKey, WindowKey: source.WindowKey}]
		if period.First.IsZero() {
			period = reviewPeriod{First: source.CreatedAt, Last: source.CreatedAt}
		}
		if err := appendItems(newReviewItem("limit:"+source.ID, domain.ReviewKindUsageLimitUnassociated, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, source.HubID, source.ID, source.ID, source.RawServiceIdentifier, period, "limit source has no logical-account association", nil, source.AccountKey)); err != nil {
			return nil, err
		}
	}

	identification, err := readReviewIdentificationCandidates(ctx, database)
	if err != nil {
		return nil, err
	}
	if err := appendItems(identification...); err != nil {
		return nil, err
	}
	accounts, err := readReviewHubAccounts(ctx, database)
	if err != nil {
		return nil, err
	}
	if err := appendItems(accounts...); err != nil {
		return nil, err
	}
	labels, err := readReviewLabelChanges(ctx, database)
	if err != nil {
		return nil, err
	}
	if err := appendItems(labels...); err != nil {
		return nil, err
	}
	billing, err := readReviewBilling(ctx, database)
	if err != nil {
		return nil, err
	}
	if err := appendItems(billing...); err != nil {
		return nil, err
	}
	completeness, err := readReviewCompleteness(ctx, database, costSources, costPeriods)
	if err != nil {
		return nil, err
	}
	if err := appendItems(completeness...); err != nil {
		return nil, err
	}
	warnings, err := readReviewWarnings(ctx, database, costObservations, limitObservations, costSources, limitSources)
	if err != nil {
		return nil, err
	}
	if err := appendItems(warnings...); err != nil {
		return nil, err
	}
	planIssues, err := readReviewPlanIssues(ctx, database, limitSources, limitObservations, limitPeriods, limitLinks, histories, versions)
	if err != nil {
		return nil, err
	}
	if err := appendItems(planIssues...); err != nil {
		return nil, err
	}
	for index := range items {
		if items[index].CurrentAssociation == nil {
			items[index].CurrentAssociation = reviewCurrentAssociation(
				items[index], costLinks, limitLinks, logicalAccountNames, limitMeanings, histories, versions,
			)
		}
	}
	return items, nil
}

func newReviewItem(id string, kind domain.ReviewKind, state domain.ReviewState, impact domain.ReviewImpact, hubID, sourceID, targetID, target string, period reviewPeriod, exclusion string, evidence []string, accountKey ...string) domain.ReviewItem {
	item := domain.ReviewItem{
		ID: id, Kind: kind, State: state, Impact: impact, HubID: hubID,
		SourceID: sourceID, TargetID: targetID, Target: target,
		FirstObservedAt: period.First.UTC(), LastObservedAt: period.Last.UTC(),
		Count: 1, EvidenceIDs: append([]string(nil), evidence...),
		EstimationExclusionReason: exclusion,
	}
	if len(accountKey) > 0 {
		item.AccountKey = accountKey[0]
	}
	return item
}

func reviewObservationPeriods(observations []reviewObservation) map[reviewSourceKey]reviewPeriod {
	result := make(map[reviewSourceKey]reviewPeriod)
	for _, observation := range observations {
		key := reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, AccountKey: observation.AccountKey, WindowKey: observation.WindowKey}
		period := result[key]
		if period.First.IsZero() || observation.ObservedAt.Before(period.First) {
			period.First = observation.ObservedAt
		}
		if period.Last.IsZero() || observation.ObservedAt.After(period.Last) {
			period.Last = observation.ObservedAt
		}
		result[key] = period
	}
	return result
}

func readReviewSources(ctx context.Context, database *sql.DB, cost bool) ([]reviewSource, error) {
	query := `SELECT usage_limit_source_id, hub_id, device_id, account_key, raw_service_identifier, window_key, created_at FROM usage_limit_sources ORDER BY hub_id, device_id, raw_service_identifier, account_key, window_key, usage_limit_source_id`
	if cost {
		query = `SELECT usage_cost_source_id, hub_id, device_id, '', raw_service_identifier, '', created_at FROM usage_cost_sources ORDER BY hub_id, device_id, raw_service_identifier, usage_cost_source_id`
	}
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("read review sources: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]reviewSource, 0)
	for rows.Next() {
		var source reviewSource
		var created string
		if err := rows.Scan(&source.ID, &source.HubID, &source.DeviceID, &source.AccountKey, &source.RawServiceIdentifier, &source.WindowKey, &created); err != nil {
			return nil, fmt.Errorf("scan review source: %w", err)
		}
		source.CreatedAt, err = parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse review source time: %w", err)
		}
		result = append(result, source)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review sources: %w", err)
	}
	return result, nil
}

func readReviewObservations(ctx context.Context, database *sql.DB, cost bool) ([]reviewObservation, error) {
	query := `SELECT observation_id, hub_id, device_id, raw_service_identifier, account_key, window_key, plan_label, provider_updated_at, dedupe_state FROM usage_limit_observations`
	if cost {
		query = `SELECT observation_id, hub_id, device_id, raw_service_identifier, '', '', '', usage_updated_at, dedupe_state FROM usage_cost_observations`
	}
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("read review observations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]reviewObservation, 0)
	for rows.Next() {
		var observation reviewObservation
		var observed string
		if err := rows.Scan(&observation.ID, &observation.HubID, &observation.DeviceID, &observation.RawServiceIdentifier, &observation.AccountKey, &observation.WindowKey, &observation.PlanLabel, &observed, &observation.DedupeState); err != nil {
			return nil, fmt.Errorf("scan review observation: %w", err)
		}
		observation.ObservedAt, err = parseUTC(observed)
		if err != nil {
			return nil, fmt.Errorf("parse review observation time: %w", err)
		}
		result = append(result, observation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review observations: %w", err)
	}
	return result, nil
}

func readAssociatedReviewSources(ctx context.Context, database *sql.DB, cost bool) (map[string]struct{}, error) {
	table := "usage_limit_source_links"
	column := "usage_limit_source_id"
	if cost {
		table, column = "usage_cost_source_account_links", "usage_cost_source_id"
	}
	rows, err := database.QueryContext(ctx, `SELECT DISTINCT `+column+` FROM `+table)
	if err != nil {
		return nil, fmt.Errorf("read associated review sources: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan associated review source: %w", err)
		}
		result[id] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read associated review sources: %w", err)
	}
	return result, nil
}

func readReviewIdentificationCandidates(ctx context.Context, database *sql.DB) ([]domain.ReviewItem, error) {
	rows, err := database.QueryContext(ctx, `SELECT candidate_id, raw_limit_service_identifier, raw_reported_plan_name, first_observed_at, last_observed_at, created_at FROM identification_candidates WHERE state = 'unconfirmed' ORDER BY candidate_id`)
	if err != nil {
		return nil, fmt.Errorf("read review identification candidates: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.ReviewItem, 0)
	for rows.Next() {
		var id, rawIdentifier, rawPlan, first, last, created sql.NullString
		if err := rows.Scan(&id, &rawIdentifier, &rawPlan, &first, &last, &created); err != nil {
			return nil, fmt.Errorf("scan review identification candidate: %w", err)
		}
		createdAt, err := parseUTC(created.String)
		if err != nil {
			return nil, fmt.Errorf("parse identification candidate creation time: %w", err)
		}
		period, err := nullableReviewPeriod(first, last, createdAt)
		if err != nil {
			return nil, err
		}
		item := newReviewItem("identification:"+id.String, domain.ReviewKindIdentificationCandidate, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, "", "", id.String, rawIdentifier.String, period, "service or plan identification is unconfirmed", nil)
		item.RawLimitServiceIdentifier = rawIdentifier.String
		item.RawReportedPlanName = rawPlan.String
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review identification candidates: %w", err)
	}
	return result, nil
}

func readReviewHubAccounts(ctx context.Context, database *sql.DB) ([]domain.ReviewItem, error) {
	rows, err := database.QueryContext(ctx, `SELECT hac.hub_account_candidate_id, hac.hub_id, hac.account_key, hac.display_name, hac.workspace_name, hac.device_name, hac.state, hac.first_observed_at, hac.last_observed_at, hac.created_at, COALESCE(la.display_name, '') FROM hub_account_candidates hac LEFT JOIN logical_accounts la ON la.logical_account_id = hac.logical_account_id WHERE hac.state IN ('unconfirmed', 'archived_reconfirmation') ORDER BY hac.hub_id, hac.hub_account_candidate_id`)
	if err != nil {
		return nil, fmt.Errorf("read review Hub accounts: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.ReviewItem, 0)
	for rows.Next() {
		var id, hubID, accountKey, displayName, workspace, device, state, logicalAccountName string
		var first, last, created sql.NullString
		if err := rows.Scan(&id, &hubID, &accountKey, &displayName, &workspace, &device, &state, &first, &last, &created, &logicalAccountName); err != nil {
			return nil, fmt.Errorf("scan review Hub account: %w", err)
		}
		createdAt, err := parseUTC(created.String)
		if err != nil {
			return nil, fmt.Errorf("parse Hub account creation time: %w", err)
		}
		period, err := nullableReviewPeriod(first, last, createdAt)
		if err != nil {
			return nil, err
		}
		item := newReviewItem("hub-account:"+id, domain.ReviewKindHubAccountCandidate, domain.ReviewState(state), domain.ReviewImpactCalculationIntervalImpossible, hubID, id, id, accountKey, period, "Hub account candidate is not confirmed for a logical account", nil, accountKey)
		item.AccountDisplayName, item.WorkspaceName, item.DeviceName = displayName, workspace, device
		if logicalAccountName != "" {
			item.CurrentAssociation = &domain.ReviewCurrentAssociation{LogicalAccountDisplayName: logicalAccountName}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review Hub accounts: %w", err)
	}
	return result, nil
}

func readReviewLabelChanges(ctx context.Context, database *sql.DB) ([]domain.ReviewItem, error) {
	rows, err := database.QueryContext(ctx, `SELECT candidate_id, hub_id, hub_account_key, raw_limit_service_identifier, old_label, new_label, first_observed_at, last_observed_at, created_at FROM limit_label_change_candidates WHERE state = 'unconfirmed' ORDER BY hub_id, candidate_id`)
	if err != nil {
		return nil, fmt.Errorf("read review label changes: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.ReviewItem, 0)
	for rows.Next() {
		var id, hubID, accountKey, rawIdentifier, oldLabel, newLabel string
		var first, last, created sql.NullString
		if err := rows.Scan(&id, &hubID, &accountKey, &rawIdentifier, &oldLabel, &newLabel, &first, &last, &created); err != nil {
			return nil, fmt.Errorf("scan review label change: %w", err)
		}
		createdAt, err := parseUTC(created.String)
		if err != nil {
			return nil, fmt.Errorf("parse label change creation time: %w", err)
		}
		period, err := nullableReviewPeriod(first, last, createdAt)
		if err != nil {
			return nil, err
		}
		item := newReviewItem("label-change:"+id, domain.ReviewKindLabelChange, domain.ReviewStateUnconfirmed, domain.ReviewImpactCurrentCalculation, hubID, "", id, rawIdentifier, period, "limit label change is unconfirmed", nil, accountKey)
		item.Target = oldLabel + " -> " + newLabel
		item.RawLimitServiceIdentifier = rawIdentifier
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review label changes: %w", err)
	}
	return result, nil
}

func readReviewBilling(ctx context.Context, database *sql.DB) ([]domain.ReviewItem, error) {
	rows, err := database.QueryContext(ctx, `SELECT limit_definition_id, meaning, created_at, updated_at FROM limit_definitions WHERE cycle_type = 'billing' AND billing_confirmation = 'unconfirmed' ORDER BY limit_definition_id`)
	if err != nil {
		return nil, fmt.Errorf("read review billing definitions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.ReviewItem, 0)
	for rows.Next() {
		var id, meaning, created, updated string
		if err := rows.Scan(&id, &meaning, &created, &updated); err != nil {
			return nil, fmt.Errorf("scan review billing definition: %w", err)
		}
		createdAt, err := parseUTC(created)
		if err != nil {
			return nil, fmt.Errorf("parse billing definition creation time: %w", err)
		}
		updatedAt, err := parseUTC(updated)
		if err != nil {
			return nil, fmt.Errorf("parse billing definition update time: %w", err)
		}
		item := newReviewItem("billing:"+id, domain.ReviewKindBillingMonthly, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, "", "", id, meaning, reviewPeriod{First: createdAt, Last: updatedAt}, "billing window is not confirmed as monthly", nil)
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review billing definitions: %w", err)
	}
	return result, nil
}

func readReviewCompleteness(ctx context.Context, database *sql.DB, sources []reviewSource, periods map[reviewSourceKey]reviewPeriod) ([]domain.ReviewItem, error) {
	rows, err := database.QueryContext(ctx, `SELECT completeness_id, usage_cost_source_id, valid_from, valid_to, state, updated_at FROM usage_cost_source_completeness ORDER BY usage_cost_source_id, valid_from, completeness_id`)
	if err != nil {
		return nil, fmt.Errorf("read review completeness: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.ReviewItem, 0)
	segments := make(map[string][]reviewCompletenessSegment)
	for rows.Next() {
		var id, sourceID, from, state, updated string
		var to sql.NullString
		if err := rows.Scan(&id, &sourceID, &from, &to, &state, &updated); err != nil {
			return nil, fmt.Errorf("scan review completeness: %w", err)
		}
		if state != string(domain.CompletenessUnconfirmed) {
			start, parseErr := parseUTC(from)
			if parseErr != nil {
				return nil, fmt.Errorf("parse completeness start: %w", parseErr)
			}
			var end *time.Time
			if to.Valid {
				value, parseErr := parseUTC(to.String)
				if parseErr != nil {
					return nil, fmt.Errorf("parse completeness end: %w", parseErr)
				}
				end = &value
			}
			segments[sourceID] = append(segments[sourceID], reviewCompletenessSegment{Start: start, End: end})
			continue
		}
		start, err := parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse completeness start: %w", err)
		}
		last, err := parseUTC(updated)
		if err != nil {
			return nil, fmt.Errorf("parse completeness update time: %w", err)
		}
		item := newReviewItem("completeness:"+id, domain.ReviewKindCompleteness, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, "", sourceID, id, sourceID, reviewPeriod{First: start, Last: last}, "source completeness is unconfirmed", nil)
		if to.Valid {
			end, parseErr := parseUTC(to.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse completeness end: %w", parseErr)
			}
			item.TargetPeriodEnd = &end
		}
		item.TargetPeriodStart = &start
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review completeness: %w", err)
	}
	for _, source := range sources {
		key := reviewSourceKey{HubID: source.HubID, DeviceID: source.DeviceID, RawServiceIdentifier: source.RawServiceIdentifier}
		period, ok := periods[key]
		if ok && !reviewCompletenessCovers(segments[source.ID], period) {
			item := newReviewItem("completeness-missing:"+source.ID, domain.ReviewKindCompleteness, domain.ReviewStateMissing, domain.ReviewImpactCalculationIntervalImpossible, source.HubID, source.ID, source.ID, source.RawServiceIdentifier, period, "source completeness has not been recorded for the whole observed interval", nil)
			item.TargetPeriodStart = &period.First
			item.TargetPeriodEnd = &period.Last
			result = append(result, item)
		}
	}
	return result, nil
}

type reviewCompletenessSegment struct {
	Start time.Time
	End   *time.Time
}

func reviewCompletenessCovers(segments []reviewCompletenessSegment, period reviewPeriod) bool {
	if len(segments) == 0 {
		return false
	}
	sort.Slice(segments, func(i, j int) bool { return segments[i].Start.Before(segments[j].Start) })
	cursor := period.First
	for _, segment := range segments {
		if segment.End != nil && !cursor.Before(*segment.End) {
			continue
		}
		if segment.Start.After(cursor) {
			return false
		}
		if segment.End == nil || period.Last.Before(*segment.End) {
			return true
		}
		cursor = *segment.End
	}
	return false
}

func readReviewWarnings(ctx context.Context, database *sql.DB, cost, limit []reviewObservation, costSources, limitSources []reviewSource) ([]domain.ReviewItem, error) {
	type warningKey struct{ HubID, DeviceID, RawServiceIdentifier, Kind string }
	type warningAggregate struct {
		item domain.ReviewItem
	}
	aggregates := make(map[warningKey]*warningAggregate)
	costSourceIDs := reviewSourceIDs(costSources)
	limitSourceIDs := reviewSourceIDs(limitSources)
	add := func(observation reviewObservation, sourceID string, kind domain.ReviewKind, reason string, impact domain.ReviewImpact) {
		key := warningKey{observation.HubID, observation.DeviceID, observation.RawServiceIdentifier, string(kind)}
		aggregate, ok := aggregates[key]
		if !ok {
			aggregate = &warningAggregate{item: newReviewItem("warning:"+observation.HubID+":"+observation.DeviceID+":"+observation.RawServiceIdentifier+":"+string(kind), kind, domain.ReviewStateActive, impact, observation.HubID, sourceID, sourceID, observation.RawServiceIdentifier, reviewPeriod{First: observation.ObservedAt, Last: observation.ObservedAt}, reason, []string{observation.ID})}
			aggregates[key] = aggregate
			return
		}
		item := &aggregate.item
		if observation.ObservedAt.Before(item.FirstObservedAt) {
			item.FirstObservedAt = observation.ObservedAt
		}
		if observation.ObservedAt.After(item.LastObservedAt) {
			item.LastObservedAt = observation.ObservedAt
		}
		item.Count++
		item.EvidenceIDs = append(item.EvidenceIDs, observation.ID)
	}
	for _, observation := range cost {
		if observation.DedupeState == "conflict" {
			add(observation, costSourceIDs[reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier}], domain.ReviewKindCostDedupeConflict, "cost observations have conflicting dedupe fingerprints", domain.ReviewImpactCurrentCalculation)
		}
	}
	for _, observation := range limit {
		if strings.TrimSpace(observation.AccountKey) == "" {
			add(observation, limitSourceIDs[reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, AccountKey: observation.AccountKey, WindowKey: observation.WindowKey}], domain.ReviewKindMissingAccountKey, "empty accountKey prevents account association", domain.ReviewImpactCalculationIntervalImpossible)
		}
		if observation.DedupeState == "conflict" {
			add(observation, limitSourceIDs[reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, AccountKey: observation.AccountKey, WindowKey: observation.WindowKey}], domain.ReviewKindLimitDedupeConflict, "limit observations have conflicting dedupe fingerprints", domain.ReviewImpactCurrentCalculation)
		}
	}
	result := make([]domain.ReviewItem, 0, len(aggregates))
	for _, aggregate := range aggregates {
		result = append(result, aggregate.item)
	}
	return result, nil
}

func readReviewPlanIssues(ctx context.Context, database *sql.DB, sources []reviewSource, observations []reviewObservation, periods map[reviewSourceKey]reviewPeriod, links map[string][]reviewLink, histories map[string][]reviewHistory, versions map[string]string) ([]domain.ReviewItem, error) {
	sourceIDs := make(map[reviewSourceKey]string, len(sources))
	for _, source := range sources {
		sourceIDs[reviewSourceKey{HubID: source.HubID, DeviceID: source.DeviceID, RawServiceIdentifier: source.RawServiceIdentifier, AccountKey: source.AccountKey, WindowKey: source.WindowKey}] = source.ID
	}
	type issueKey struct{ HubID, SourceID string }
	issues := make(map[issueKey]*domain.ReviewItem)
	for _, observation := range observations {
		sourceID := sourceIDs[reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, AccountKey: observation.AccountKey, WindowKey: observation.WindowKey}]
		if sourceID == "" {
			continue
		}
		link, ok := activeReviewLink(links[sourceID], observation.ObservedAt)
		if !ok {
			continue
		}
		history, ok := activeReviewHistory(histories[link.LogicalAccountID], observation.ObservedAt)
		inconsistent := !ok
		if ok && strings.TrimSpace(observation.PlanLabel) != "" && strings.TrimSpace(versions[history.PlanVersionID]) != strings.TrimSpace(observation.PlanLabel) {
			inconsistent = true
		}
		if !inconsistent {
			continue
		}
		key := issueKey{HubID: observation.HubID, SourceID: sourceID}
		item, exists := issues[key]
		if !exists {
			period := periods[reviewSourceKey{HubID: observation.HubID, DeviceID: observation.DeviceID, RawServiceIdentifier: observation.RawServiceIdentifier, AccountKey: observation.AccountKey, WindowKey: observation.WindowKey}]
			if period.First.IsZero() {
				period = reviewPeriod{First: observation.ObservedAt, Last: observation.ObservedAt}
			}
			created := newReviewItem("plan-history:"+observation.HubID+":"+sourceID, domain.ReviewKindPlanHistoryInconsistency, domain.ReviewStateUnconfirmed, domain.ReviewImpactCalculationIntervalImpossible, observation.HubID, sourceID, sourceID, observation.PlanLabel, period, "reported plan cannot be reconciled with the plan history", []string{observation.ID})
			created.Count = 1
			issues[key] = &created
			continue
		}
		if observation.ObservedAt.Before(item.FirstObservedAt) {
			item.FirstObservedAt = observation.ObservedAt
		}
		if observation.ObservedAt.After(item.LastObservedAt) {
			item.LastObservedAt = observation.ObservedAt
		}
		item.Count++
		item.EvidenceIDs = append(item.EvidenceIDs, observation.ID)
	}
	result := make([]domain.ReviewItem, 0, len(issues))
	for _, item := range issues {
		result = append(result, *item)
	}
	return result, nil
}

type reviewLink struct {
	LogicalAccountID  string
	LimitDefinitionID string
	ValidFrom         time.Time
	ValidTo           *time.Time
}

type reviewHistory struct {
	PlanVersionID string
	ValidFrom     time.Time
	ValidTo       *time.Time
}

func readReviewCostLinks(ctx context.Context, database *sql.DB) (map[string][]reviewLink, error) {
	return readReviewLinks(ctx, database, `SELECT usage_cost_source_id, logical_account_id, '', valid_from, valid_to FROM usage_cost_source_account_links ORDER BY usage_cost_source_id, valid_from`, "cost")
}

func readReviewLimitLinks(ctx context.Context, database *sql.DB) (map[string][]reviewLink, error) {
	return readReviewLinks(ctx, database, `SELECT usage_limit_source_id, logical_account_id, limit_definition_id, valid_from, valid_to FROM usage_limit_source_links ORDER BY usage_limit_source_id, valid_from`, "limit")
}

func readReviewLinks(ctx context.Context, database *sql.DB, query, kind string) (map[string][]reviewLink, error) {
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("read review %s links: %w", kind, err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string][]reviewLink)
	for rows.Next() {
		var sourceID, accountID, limitDefinitionID, from string
		var to sql.NullString
		if err := rows.Scan(&sourceID, &accountID, &limitDefinitionID, &from, &to); err != nil {
			return nil, fmt.Errorf("scan review %s link: %w", kind, err)
		}
		start, err := parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse review %s link start: %w", kind, err)
		}
		var end *time.Time
		if to.Valid {
			value, parseErr := parseUTC(to.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse review %s link end: %w", kind, parseErr)
			}
			end = &value
		}
		result[sourceID] = append(result[sourceID], reviewLink{LogicalAccountID: accountID, LimitDefinitionID: limitDefinitionID, ValidFrom: start, ValidTo: end})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review %s links: %w", kind, err)
	}
	return result, nil
}

func readReviewLogicalAccountNames(ctx context.Context, database *sql.DB) (map[string]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT logical_account_id, display_name FROM logical_accounts`)
	if err != nil {
		return nil, fmt.Errorf("read review logical account names: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string]string)
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("scan review logical account name: %w", err)
		}
		result[id] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review logical account names: %w", err)
	}
	return result, nil
}

func readReviewLimitMeanings(ctx context.Context, database *sql.DB) (map[string]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT limit_definition_id, meaning FROM limit_definitions`)
	if err != nil {
		return nil, fmt.Errorf("read review limit meanings: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string]string)
	for rows.Next() {
		var id, meaning string
		if err := rows.Scan(&id, &meaning); err != nil {
			return nil, fmt.Errorf("scan review limit meaning: %w", err)
		}
		result[id] = meaning
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review limit meanings: %w", err)
	}
	return result, nil
}

func reviewSourceIDs(sources []reviewSource) map[reviewSourceKey]string {
	result := make(map[reviewSourceKey]string, len(sources))
	for _, source := range sources {
		result[reviewSourceKey{
			HubID: source.HubID, DeviceID: source.DeviceID,
			RawServiceIdentifier: source.RawServiceIdentifier,
			AccountKey:           source.AccountKey, WindowKey: source.WindowKey,
		}] = source.ID
	}
	return result
}

func reviewCurrentAssociation(item domain.ReviewItem, costLinks, limitLinks map[string][]reviewLink, accountNames, limitMeanings map[string]string, histories map[string][]reviewHistory, versions map[string]string) *domain.ReviewCurrentAssociation {
	if item.SourceID == "" {
		return nil
	}
	var values []reviewLink
	switch item.Kind {
	case domain.ReviewKindUsageCostUnassociated, domain.ReviewKindCostDedupeConflict, domain.ReviewKindCompleteness:
		values = costLinks[item.SourceID]
	case domain.ReviewKindUsageLimitUnassociated, domain.ReviewKindPlanHistoryInconsistency, domain.ReviewKindMissingAccountKey, domain.ReviewKindLimitDedupeConflict:
		values = limitLinks[item.SourceID]
	case domain.ReviewKindIdentificationCandidate, domain.ReviewKindHubAccountCandidate,
		domain.ReviewKindLabelChange, domain.ReviewKindBillingMonthly:
		// These review items do not have a current source association.
	}
	link, ok := activeReviewLink(values, item.LastObservedAt)
	if !ok {
		return nil
	}
	association := &domain.ReviewCurrentAssociation{
		LogicalAccountDisplayName: accountNames[link.LogicalAccountID],
		AssociationValidFrom:      &link.ValidFrom,
		AssociationValidTo:        link.ValidTo,
	}
	if link.LimitDefinitionID != "" {
		association.LimitMeaning = limitMeanings[link.LimitDefinitionID]
		if history, exists := activeReviewHistory(histories[link.LogicalAccountID], item.LastObservedAt); exists {
			association.PlanVersionName = versions[history.PlanVersionID]
			association.PlanValidFrom = &history.ValidFrom
			association.PlanValidTo = history.ValidTo
		}
	}
	if association.LogicalAccountDisplayName == "" && association.LimitMeaning == "" && association.PlanVersionName == "" {
		return nil
	}
	return association
}

func readReviewPlanHistories(ctx context.Context, database *sql.DB) (map[string][]reviewHistory, error) {
	rows, err := database.QueryContext(ctx, `SELECT logical_account_id, plan_version_id, valid_from, valid_to FROM plan_histories ORDER BY logical_account_id, valid_from`)
	if err != nil {
		return nil, fmt.Errorf("read review plan histories: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string][]reviewHistory)
	for rows.Next() {
		var accountID, versionID, from string
		var to sql.NullString
		if err := rows.Scan(&accountID, &versionID, &from, &to); err != nil {
			return nil, fmt.Errorf("scan review plan history: %w", err)
		}
		start, err := parseUTC(from)
		if err != nil {
			return nil, fmt.Errorf("parse review plan history start: %w", err)
		}
		var end *time.Time
		if to.Valid {
			value, parseErr := parseUTC(to.String)
			if parseErr != nil {
				return nil, fmt.Errorf("parse review plan history end: %w", parseErr)
			}
			end = &value
		}
		result[accountID] = append(result[accountID], reviewHistory{PlanVersionID: versionID, ValidFrom: start, ValidTo: end})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review plan histories: %w", err)
	}
	return result, nil
}

func readReviewPlanVersions(ctx context.Context, database *sql.DB) (map[string]string, error) {
	rows, err := database.QueryContext(ctx, `SELECT plan_version_id, name FROM plan_versions`)
	if err != nil {
		return nil, fmt.Errorf("read review plan versions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make(map[string]string)
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, fmt.Errorf("scan review plan version: %w", err)
		}
		result[id] = name
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read review plan versions: %w", err)
	}
	return result, nil
}

func activeReviewLink(values []reviewLink, observedAt time.Time) (reviewLink, bool) {
	for _, value := range values {
		if !observedAt.Before(value.ValidFrom) || value.ValidFrom.Equal(observedAt) {
			if value.ValidTo == nil || observedAt.Before(*value.ValidTo) {
				return value, true
			}
		}
	}
	return reviewLink{}, false
}

func activeReviewHistory(values []reviewHistory, observedAt time.Time) (reviewHistory, bool) {
	for _, value := range values {
		if !observedAt.Before(value.ValidFrom) || value.ValidFrom.Equal(observedAt) {
			if value.ValidTo == nil || observedAt.Before(*value.ValidTo) {
				return value, true
			}
		}
	}
	return reviewHistory{}, false
}

func nullableReviewPeriod(first, last sql.NullString, fallback time.Time) (reviewPeriod, error) {
	period := reviewPeriod{First: fallback, Last: fallback}
	if first.Valid {
		value, err := parseUTC(first.String)
		if err != nil {
			return reviewPeriod{}, fmt.Errorf("parse review first observation time: %w", err)
		}
		period.First = value
	}
	if last.Valid {
		value, err := parseUTC(last.String)
		if err != nil {
			return reviewPeriod{}, fmt.Errorf("parse review last observation time: %w", err)
		}
		period.Last = value
	}
	if period.Last.Before(period.First) {
		return reviewPeriod{}, errors.New("review observation period is reversed")
	}
	return period, nil
}
