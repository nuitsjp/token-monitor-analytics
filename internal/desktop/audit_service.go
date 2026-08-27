package desktop

import (
	"context"
	"errors"
	"fmt"
	"time"

	"token-monitor-analytics/internal/domain"
)

// AuditService exposes only read operations for M10. The adapter owns query
// ordering, cursor validation, and JSON redaction; this layer translates the
// Wails DTO and validates user-entered date boundaries.
type AuditService struct {
	reader AuditReader
}

type AuditReader interface {
	ListConfigurationAudits(context.Context, domain.AuditListOptions) (domain.ConfigurationAuditPage, error)
}

type AuditFilterInput struct {
	Cursor     string `json:"cursor"`
	Limit      int    `json:"limit"`
	From       string `json:"from"`
	To         string `json:"to"`
	EntityType string `json:"entityType"`
	Action     string `json:"action"`
}

type AuditRecord struct {
	Sequence   int64  `json:"sequence"`
	AuditID    string `json:"auditId"`
	OccurredAt string `json:"occurredAt"`
	Actor      string `json:"actor"`
	Action     string `json:"action"`
	EntityType string `json:"entityType"`
	EntityID   string `json:"entityId"`
	BeforeJSON string `json:"beforeJson"`
	AfterJSON  string `json:"afterJson"`
}

type AuditPage struct {
	Items      []AuditRecord `json:"items"`
	NextCursor string        `json:"nextCursor"`
	HasMore    bool          `json:"hasMore"`
}

func NewAuditService(reader AuditReader) *AuditService {
	return &AuditService{reader: reader}
}

func (s *AuditService) GetAudits(ctx context.Context, input AuditFilterInput) (AuditPage, error) {
	from, err := parseAuditBoundary(input.From)
	if err != nil {
		return AuditPage{}, fmt.Errorf("invalid audit from date: %w", err)
	}
	to, err := parseAuditBoundary(input.To)
	if err != nil {
		return AuditPage{}, fmt.Errorf("invalid audit to date: %w", err)
	}
	page, err := s.reader.ListConfigurationAudits(ctx, domain.AuditListOptions{
		Cursor: input.Cursor, Limit: input.Limit, From: from, To: to,
		EntityType: input.EntityType, Action: input.Action,
	})
	if err != nil {
		return AuditPage{}, err
	}
	result := AuditPage{NextCursor: page.NextCursor, HasMore: page.HasMore, Items: make([]AuditRecord, 0, len(page.Items))}
	for _, item := range page.Items {
		result.Items = append(result.Items, AuditRecord{
			Sequence: item.Sequence, AuditID: item.AuditID,
			OccurredAt: item.OccurredAt.UTC().Format(time.RFC3339Nano),
			Actor:      item.Actor, Action: item.Action, EntityType: item.EntityType,
			EntityID: item.EntityID, BeforeJSON: item.BeforeJSON, AfterJSON: item.AfterJSON,
		})
	}
	return result, nil
}

func parseAuditBoundary(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, errors.New("expected RFC3339 timestamp")
	}
	parsed = parsed.UTC()
	return &parsed, nil
}
