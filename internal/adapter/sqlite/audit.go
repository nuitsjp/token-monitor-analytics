package sqlite

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAuditPageSize = 50
	maxAuditPageSize     = 100
)

// AuditListOptions describes a read-only audit query. Cursor is an opaque
// value returned by ListConfigurationAudits and identifies the last sequence
// in the previous page.
type AuditListOptions struct {
	Cursor     string
	Limit      int
	From       *time.Time
	To         *time.Time
	EntityType string
	Action     string
}

type ConfigurationAudit struct {
	Sequence   int64
	AuditID    string
	OccurredAt time.Time
	Actor      string
	Action     string
	EntityType string
	EntityID   string
	BeforeJSON string
	AfterJSON  string
}

type ConfigurationAuditPage struct {
	Items      []ConfigurationAudit
	NextCursor string
	HasMore    bool
}

// ListConfigurationAudits returns a stable, newest-first page. The sequence
// primary key is the tie-breaker, so records inserted while paging cannot
// move an already-read record to an earlier page.
func (l *Lifecycle) ListConfigurationAudits(ctx context.Context, options AuditListOptions) (ConfigurationAuditPage, error) {
	limit := options.Limit
	if limit == 0 {
		limit = defaultAuditPageSize
	}
	if limit < 1 || limit > maxAuditPageSize {
		return ConfigurationAuditPage{}, fmt.Errorf("audit page size must be between 1 and %d", maxAuditPageSize)
	}
	if options.From != nil && options.To != nil && !options.From.Before(*options.To) {
		return ConfigurationAuditPage{}, errors.New("audit date range must be non-empty")
	}
	cursor, hasCursor, err := decodeAuditCursor(options.Cursor)
	if err != nil {
		return ConfigurationAuditPage{}, err
	}

	database, err := l.DB()
	if err != nil {
		return ConfigurationAuditPage{}, err
	}
	query := strings.Builder{}
	query.WriteString(`SELECT sequence, audit_id, occurred_at, actor, action, entity_type, entity_id, before_json, after_json
		FROM configuration_audits WHERE 1 = 1`)
	args := make([]any, 0, 3)
	if hasCursor {
		query.WriteString(" AND sequence < ?")
		args = append(args, cursor)
	}
	if options.EntityType != "" {
		query.WriteString(" AND entity_type = ?")
		args = append(args, options.EntityType)
	}
	if options.Action != "" {
		query.WriteString(" AND action = ?")
		args = append(args, options.Action)
	}
	query.WriteString(" ORDER BY sequence DESC")
	rows, err := database.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return ConfigurationAuditPage{}, fmt.Errorf("list configuration audits: %w", err)
	}
	defer rows.Close()

	items := make([]ConfigurationAudit, 0, limit)
	for rows.Next() {
		var (
			item                  ConfigurationAudit
			occurredAt            string
			beforeJSON, afterJSON sql.NullString
		)
		if err := rows.Scan(&item.Sequence, &item.AuditID, &occurredAt, &item.Actor,
			&item.Action, &item.EntityType, &item.EntityID, &beforeJSON, &afterJSON); err != nil {
			return ConfigurationAuditPage{}, fmt.Errorf("scan configuration audit: %w", err)
		}
		item.OccurredAt, err = parseUTC(occurredAt)
		if err != nil {
			return ConfigurationAuditPage{}, fmt.Errorf("parse configuration audit time: %w", err)
		}
		if options.From != nil && item.OccurredAt.Before(options.From.UTC()) {
			continue
		}
		if options.To != nil && !item.OccurredAt.Before(options.To.UTC()) {
			continue
		}
		item.BeforeJSON = sanitizeAuditJSON(beforeJSON.String)
		item.AfterJSON = sanitizeAuditJSON(afterJSON.String)
		items = append(items, item)
		if len(items) == limit+1 {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return ConfigurationAuditPage{}, fmt.Errorf("read configuration audits: %w", err)
	}
	page := ConfigurationAuditPage{Items: items}
	if len(items) > limit {
		page.HasMore = true
		page.Items = items[:limit]
		page.NextCursor = encodeAuditCursor(page.Items[len(page.Items)-1].Sequence)
	}
	return page, nil
}

func encodeAuditCursor(sequence int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(sequence, 10)))
}

func decodeAuditCursor(cursor string) (int64, bool, error) {
	if cursor == "" {
		return 0, false, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, false, errors.New("invalid audit cursor")
	}
	sequence, err := strconv.ParseInt(string(decoded), 10, 64)
	if err != nil || sequence <= 0 {
		return 0, false, errors.New("invalid audit cursor")
	}
	return sequence, true, nil
}

var sensitiveAuditKey = func() map[string]struct{} {
	keys := []string{
		"secret", "password", "credential", "authorization", "cookie", "auth", "header", "headers", "token", "key",
		"apikey", "accesstoken", "refreshtoken", "clientsecret", "privatekey",
	}
	result := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		result[key] = struct{}{}
	}
	return result
}()

// sanitizeAuditJSON keeps structured, non-secret before/after data useful to
// the viewer while masking fields that can carry credentials. Invalid or
// empty values are never returned verbatim.
func sanitizeAuditJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return `{"_redacted":"invalid JSON"}`
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return `{"_redacted":"invalid JSON"}`
	}
	sanitized := sanitizeAuditValue(value, "")
	encoded, err := json.Marshal(sanitized)
	if err != nil {
		return `{"_redacted":"unavailable"}`
	}
	return string(encoded)
}

func sanitizeAuditValue(value any, key string) any {
	if isSensitiveAuditKey(key) {
		return "[非表示]"
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for childKey, childValue := range typed {
			result[childKey] = sanitizeAuditValue(childValue, childKey)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for i, childValue := range typed {
			result[i] = sanitizeAuditValue(childValue, key)
		}
		return result
	default:
		return value
	}
}

func isSensitiveAuditKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.NewReplacer("_", "", "-", "", " ", "").Replace(key)
	if _, found := sensitiveAuditKey[key]; found {
		return true
	}
	for _, part := range []string{"secret", "password", "credential", "authorization", "cookie", "apikey"} {
		if strings.Contains(key, part) {
			return true
		}
	}
	return strings.HasSuffix(key, "_token") || strings.HasSuffix(key, "-token")
}
