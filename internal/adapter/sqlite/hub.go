package sqlite

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"token-monitor-analytics/internal/domain"
)

type Hub = domain.Hub

func (l *Lifecycle) CreateHub(ctx context.Context, hub Hub) error {
	if err := validateHub(&hub); err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Hub creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO hubs
			(hub_id, display_name, url, collection_enabled, collection_interval_seconds, api_contract, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		hub.ID, hub.DisplayName, hub.URL, hub.CollectionEnabled, hub.CollectionIntervalSeconds,
		hub.APIContract, utcText(hub.CreatedAt), utcText(hub.UpdatedAt),
	)
	if err != nil {
		return fmt.Errorf("insert Hub: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO hub_connection_statuses (hub_id, state) VALUES (?, 'not_checked')`, hub.ID)
	if err != nil {
		return fmt.Errorf("insert Hub connection status: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Hub creation: %w", err)
	}
	return nil
}

func (l *Lifecycle) UpdateHub(ctx context.Context, hubID, displayName, rawURL string, intervalSeconds int64, updatedAt time.Time) error {
	if _, err := uuid.Parse(hubID); err != nil {
		return errors.New("hub ID is not a UUID")
	}
	if displayName == "" || updatedAt.IsZero() || intervalSeconds <= 0 {
		return errors.New("hub update has an invalid required field")
	}
	normalizedURL, err := domain.ValidateHubURL(rawURL)
	if err != nil {
		return err
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `
		UPDATE hubs SET display_name = ?, url = ?, collection_interval_seconds = ?, updated_at = ?
		WHERE hub_id = ?`, displayName, normalizedURL, intervalSeconds, utcText(updatedAt), hubID)
	if err != nil {
		return fmt.Errorf("update Hub: %w", err)
	}
	return requireOneHub(result)
}

func (l *Lifecycle) SetHubCollectionEnabled(ctx context.Context, hubID string, enabled bool, updatedAt time.Time) error {
	if _, err := uuid.Parse(hubID); err != nil {
		return errors.New("hub ID is not a UUID")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `UPDATE hubs SET collection_enabled = ?, updated_at = ? WHERE hub_id = ?`, enabled, utcText(updatedAt), hubID)
	if err != nil {
		return fmt.Errorf("change Hub collection state: %w", err)
	}
	return requireOneHub(result)
}

func (l *Lifecycle) SetHubEnabled(ctx context.Context, hubID string, enabled bool, updatedAt time.Time) error {
	if _, err := uuid.Parse(hubID); err != nil {
		return errors.New("hub ID is not a UUID")
	}
	database, err := l.DB()
	if err != nil {
		return err
	}
	result, err := database.ExecContext(ctx, `
		UPDATE hubs
		SET enabled = ?,
		    collection_enabled = CASE WHEN ? THEN collection_enabled ELSE 0 END,
		    updated_at = ?
		WHERE hub_id = ?`, enabled, enabled, utcText(updatedAt), hubID)
	if err != nil {
		return fmt.Errorf("change Hub enabled state: %w", err)
	}
	return requireOneHub(result)
}

func validateHub(hub *Hub) error {
	if _, err := uuid.Parse(hub.ID); err != nil {
		return errors.New("hub ID is not a UUID")
	}
	if hub.DisplayName == "" || hub.CollectionIntervalSeconds <= 0 || hub.CreatedAt.IsZero() || hub.UpdatedAt.IsZero() {
		return errors.New("hub has an invalid required field")
	}
	normalizedURL, err := domain.ValidateHubURL(hub.URL)
	if err != nil {
		return err
	}
	hub.URL = normalizedURL
	return nil
}

func requireOneHub(result interface{ RowsAffected() (int64, error) }) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read affected Hub count: %w", err)
	}
	if count != 1 {
		return errors.New("hub was not found")
	}
	return nil
}
