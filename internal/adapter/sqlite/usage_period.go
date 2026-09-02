package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"token-monitor-analytics/internal/domain"
)

func (l *Lifecycle) ListUsagePeriodObservations(ctx context.Context) ([]domain.UsagePeriodObservation, error) {
	database, err := l.DB()
	if err != nil {
		return nil, err
	}
	rows, err := database.QueryContext(ctx, `
		SELECT o.period_observation_id, o.snapshot_id, o.hub_id, h.display_name, o.device_id,
		       o.period_kind, o.period_key, o.period_ends_at, o.usage_updated_at, o.source_timezone,
		       o.token_count, o.api_cost_usd_text, o.tool_tokens_json, o.tool_costs_json,
		       o.model_tokens_json, o.model_costs_json, o.tool_model_tokens_json, o.tool_model_costs_json,
		       o.json_path, o.dedupe_state
		FROM usage_period_observations o
		LEFT JOIN normalization_runs nr ON nr.snapshot_id = o.snapshot_id AND nr.normalization_generation = o.normalization_generation
		JOIN hubs h ON h.hub_id = o.hub_id
		WHERE o.dedupe_state = 'canonical' AND (nr.state = 'active' OR nr.state IS NULL)
		ORDER BY o.hub_id, o.device_id, o.period_kind, o.period_key, o.usage_updated_at, o.period_observation_id`)
	if err != nil {
		return nil, fmt.Errorf("list usage period observations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	result := make([]domain.UsagePeriodObservation, 0)
	for rows.Next() {
		var item domain.UsagePeriodObservation
		var endsAt, observedAt, toolTokensJSON, toolCostsJSON, modelTokensJSON, modelCostsJSON, toolModelTokensJSON, toolModelCostsJSON string
		var cost sql.NullString
		if err := rows.Scan(&item.ID, &item.SnapshotID, &item.HubID, &item.HubName, &item.DeviceID,
			&item.PeriodKind, &item.PeriodKey, &endsAt, &observedAt, &item.SourceTimezone,
			&item.TokenCount, &cost, &toolTokensJSON, &toolCostsJSON, &modelTokensJSON, &modelCostsJSON,
			&toolModelTokensJSON, &toolModelCostsJSON, &item.JSONPath, &item.DedupeState); err != nil {
			return nil, fmt.Errorf("scan usage period observation: %w", err)
		}
		item.PeriodEndsAt, err = parseUTC(endsAt)
		if err != nil {
			return nil, fmt.Errorf("parse usage period ends at: %w", err)
		}
		item.UsageUpdatedAt, err = parseUTC(observedAt)
		if err != nil {
			return nil, fmt.Errorf("parse usage period updated at: %w", err)
		}
		if cost.Valid {
			item.APICostUSDText = cost.String
		}
		if err := json.Unmarshal([]byte(toolTokensJSON), &item.ToolTokens); err != nil {
			return nil, fmt.Errorf("decode usage period tool tokens: %w", err)
		}
		if err := json.Unmarshal([]byte(toolCostsJSON), &item.ToolCosts); err != nil {
			return nil, fmt.Errorf("decode usage period tool costs: %w", err)
		}
		if err := json.Unmarshal([]byte(modelTokensJSON), &item.ModelTokens); err != nil {
			return nil, fmt.Errorf("decode usage period model tokens: %w", err)
		}
		if err := json.Unmarshal([]byte(modelCostsJSON), &item.ModelCosts); err != nil {
			return nil, fmt.Errorf("decode usage period model costs: %w", err)
		}
		if err := json.Unmarshal([]byte(toolModelTokensJSON), &item.ToolModelTokens); err != nil {
			return nil, fmt.Errorf("decode usage period tool model tokens: %w", err)
		}
		if err := json.Unmarshal([]byte(toolModelCostsJSON), &item.ToolModelCosts); err != nil {
			return nil, fmt.Errorf("decode usage period tool model costs: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read usage period observations: %w", err)
	}
	return result, nil
}
