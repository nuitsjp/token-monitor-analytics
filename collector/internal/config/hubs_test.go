package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadHubsConfig(t *testing.T) {
	dir := t.TempDir()
	secretsPath := filepath.Join(dir, "hub-secrets.json")
	hubsPath := filepath.Join(dir, "hubs.json")

	secretsContent := `{"schemaVersion":1,"secrets":{"sec-1":"secret-value-1","sec-2":"secret-value-2"}}`
	if err := os.WriteFile(secretsPath, []byte(secretsContent), 0600); err != nil {
		t.Fatal(err)
	}

	hubsContent := `{
		"schemaVersion": 1,
		"revision": 3,
		"secretsPath": "./hub-secrets.json",
		"hubs": [
			{"id": "hub-1", "label": "Hub 1", "url": "https://hub1.example.com", "status": "active", "secretRef": "sec-1"},
			{"id": "hub-2", "label": "Hub 2", "url": "https://hub2.example.com", "status": "disabled", "secretRef": "sec-2"}
		]
	}`
	if err := os.WriteFile(hubsPath, []byte(hubsContent), 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadHubsConfig(hubsPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Revision != 3 {
		t.Errorf("expected revision 3, got %d", cfg.Revision)
	}
	if len(cfg.Hubs) != 2 {
		t.Fatalf("expected 2 hubs, got %d", len(cfg.Hubs))
	}
	if cfg.Hubs[0].Secret != "secret-value-1" || cfg.Hubs[1].Secret != "secret-value-2" {
		t.Errorf("secret resolution failed: %+v", cfg.Hubs)
	}
	if cfg.Hubs[0].Status != StatusActive || cfg.Hubs[1].Status != StatusDisabled {
		t.Errorf("status parsing failed: %+v", cfg.Hubs)
	}
}

func TestLoadHubsConfigErrors(t *testing.T) {
	dir := t.TempDir()
	secretsPath := filepath.Join(dir, "hub-secrets.json")
	hubsPath := filepath.Join(dir, "hubs.json")

	// Missing secret reference
	os.WriteFile(secretsPath, []byte(`{"schemaVersion":1,"secrets":{}}`), 0600)
	os.WriteFile(hubsPath, []byte(`{"schemaVersion":1,"revision":1,"secretsPath":"./hub-secrets.json","hubs":[{"id":"h","label":"H","url":"https://h.example.com","status":"active","secretRef":"missing"}]}`), 0600)

	if _, err := LoadHubsConfig(hubsPath); err == nil {
		t.Fatal("expected error for missing secret reference")
	}

	// Unknown field in hubs.json
	os.WriteFile(hubsPath, []byte(`{"schemaVersion":1,"revision":1,"secretsPath":"./hub-secrets.json","unknown":1,"hubs":[]}`), 0600)
	if _, err := LoadHubsConfig(hubsPath); err == nil {
		t.Fatal("expected error for unknown field")
	}

	// Absolute secretsPath
	os.WriteFile(hubsPath, []byte(`{"schemaVersion":1,"revision":1,"secretsPath":"/etc/secrets.json","hubs":[]}`), 0600)
	if _, err := LoadHubsConfig(hubsPath); err == nil {
		t.Fatal("expected error for absolute secretsPath")
	}
}

func TestCollectorConfigWithHubsPath(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "hubs.json"), []byte(`{"schemaVersion":1,"revision":0,"secretsPath":"secrets.json","hubs":[]}`), 0600)
	os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(`{"schemaVersion":1,"secrets":{}}`), 0600)
	t.Setenv("INGEST", "12345678901234567890")
	cfgPath := filepath.Join(dir, "collector.json")

	content := `{"version":1,"hubs_path":"./hubs.json","analytics_url":"https://analytics.example.com","ingest_token_env":"INGEST"}`
	os.WriteFile(cfgPath, []byte(content), 0600)

	c, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	expectedHubsPath := filepath.Join(dir, "hubs.json")
	if c.HubsPath != expectedHubsPath {
		t.Errorf("expected HubsPath %s, got %s", expectedHubsPath, c.HubsPath)
	}

	// Both hubs and hubs_path
	conflict := `{"version":1,"hubs":[{"id":"a","url":"https://a.example.com","secret_env":"S"}],"hubs_path":"./hubs.json","analytics_url":"https://analytics.example.com","ingest_token_env":"INGEST"}`
	os.WriteFile(cfgPath, []byte(conflict), 0600)
	if _, err := Load(cfgPath); err == nil {
		t.Fatal("expected error when both hubs and hubs_path are provided")
	}
}

func TestSharedLabelValidation(t *testing.T) {
	raw, err := os.ReadFile("../../../test-fixtures/hub-labels.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string
		Label string
		Valid bool
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "hubs.json")
			data, err := json.Marshal(HubsFile{SchemaVersion: 1, Revision: 1, SecretsPath: "secrets.json", Hubs: []ManagedHub{{ID: "h1", Label: tc.Label, URL: "https://example.com", Status: "active", SecretRef: "s1"}}})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			_, err = LoadHubsFile(file)
			if (err == nil) != tc.Valid {
				t.Fatalf("valid=%v, error=%v", tc.Valid, err)
			}
		})
	}
}
