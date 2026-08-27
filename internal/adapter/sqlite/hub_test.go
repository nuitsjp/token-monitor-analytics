package sqlite

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestHubIdentitySurvivesDuplicateURLUpdateAndDisable(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	firstID := uuid.NewString()
	secondID := uuid.NewString()
	for index, id := range []string{firstID, secondID} {
		err := lifecycle.CreateHub(context.Background(), Hub{
			ID: id, DisplayName: "Hub", URL: "https://hub.example.test",
			CollectionEnabled: true, CollectionIntervalSeconds: 300,
			CreatedAt: now.Add(time.Duration(index) * time.Second), UpdatedAt: now.Add(time.Duration(index) * time.Second),
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	if err := lifecycle.UpdateHub(context.Background(), firstID, "Renamed", "https://new.example.test", 600, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.SetHubCollectionEnabled(context.Background(), firstID, false, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}

	database, _ := lifecycle.DB()
	rows, err := database.QueryContext(context.Background(), `SELECT hub_id, url, collection_enabled FROM hubs ORDER BY created_at`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	type result struct {
		id      string
		url     string
		enabled bool
	}
	var got []result
	for rows.Next() {
		var item result
		if err := rows.Scan(&item.id, &item.url, &item.enabled); err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	t.Run("P1-HUB-01 Hub identity is immutable across URL changes and disable", func(t *testing.T) {
		if len(got) != 2 || got[0].id != firstID || got[0].url != "https://new.example.test" || got[0].enabled || got[1].id != secondID {
			t.Fatalf("unexpected Hubs: %#v", got)
		}
	})
	t.Run("DM-ID-01 Hub identity is immutable across URL changes", func(t *testing.T) {
		if len(got) != 2 || got[0].id != firstID || got[0].url != "https://new.example.test" || got[0].enabled || got[1].id != secondID {
			t.Fatalf("unexpected Hubs: %#v", got)
		}
	})
}

func TestCreateHubAcceptsPrivateHTTP(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	now := time.Now().UTC()
	err := lifecycle.CreateHub(context.Background(), Hub{
		ID: uuid.NewString(), DisplayName: "LAN Hub", URL: "http://192.168.0.16:17321",
		CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	database, _ := lifecycle.DB()
	var count int
	if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM hubs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("Hub count = %d", count)
	}
}

func TestCreateHubRejectsPublicHTTPWithoutWriting(t *testing.T) {
	lifecycle := openTestLifecycle(t)
	now := time.Now().UTC()
	err := lifecycle.CreateHub(context.Background(), Hub{
		ID: uuid.NewString(), DisplayName: "Public HTTP", URL: "http://203.0.113.10:17321",
		CollectionEnabled: true, CollectionIntervalSeconds: 300, CreatedAt: now, UpdatedAt: now,
	})
	if err == nil {
		t.Fatal("CreateHub succeeded")
	}
	database, _ := lifecycle.DB()
	var count int
	if err := database.QueryRowContext(t.Context(), `SELECT count(*) FROM hubs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("Hub count = %d", count)
	}
}
