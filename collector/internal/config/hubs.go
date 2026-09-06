package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type HubStatus string

const (
	StatusActive   HubStatus = "active"
	StatusDisabled HubStatus = "disabled"
	StatusArchived HubStatus = "archived"
)

type ManagedHub struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	URL       string `json:"url"`
	Status    string `json:"status"`
	SecretRef string `json:"secretRef"`
}

type HubsFile struct {
	SchemaVersion int          `json:"schemaVersion"`
	Revision      int          `json:"revision"`
	SecretsPath   string       `json:"secretsPath"`
	Hubs          []ManagedHub `json:"hubs"`
}

type HubSecretsFile struct {
	SchemaVersion int               `json:"schemaVersion"`
	Secrets       map[string]string `json:"secrets"`
}

type ResolvedHub struct {
	ID        string
	Label     string
	URL       string
	Status    HubStatus
	SecretRef string
	Secret    string
}

type HubsConfig struct {
	Revision int
	Hubs     []ResolvedHub
}

const maxConfigBytes int64 = 262144

func LoadHubsFile(path string) (HubsFile, error) {
	var hf HubsFile
	f, err := os.Open(path)
	if err != nil {
		return hf, err
	}
	defer f.Close()

	d := json.NewDecoder(io.LimitReader(f, maxConfigBytes))
	d.DisallowUnknownFields()
	if err := d.Decode(&hf); err != nil {
		return hf, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return hf, errors.New("hubs file must contain exactly one JSON object")
	}

	if hf.SchemaVersion != 1 {
		return hf, errors.New("hubs file schemaVersion must be 1")
	}
	if hf.Revision < 0 {
		return hf, errors.New("hubs file revision must be non-negative")
	}
	if hf.SecretsPath == "" || filepath.IsAbs(hf.SecretsPath) {
		return hf, errors.New("hubs file secretsPath must be a non-empty relative path")
	}

	ids := make(map[string]bool)
	urls := make(map[string]bool)
	activeCount := 0

	for _, hub := range hf.Hubs {
		if !ValidID(hub.ID) || ids[hub.ID] {
			return hf, fmt.Errorf("invalid or duplicate hub ID: %s", hub.ID)
		}
		ids[hub.ID] = true

		if strings.TrimSpace(hub.Label) == "" || len(hub.Label) > 128 {
			return hf, fmt.Errorf("hub %s: label must be 1..128 characters", hub.ID)
		}
		if err := ValidateBaseURL(hub.URL); err != nil {
			return hf, fmt.Errorf("hub %s url: %w", hub.ID, err)
		}
		if hub.Status != string(StatusActive) && hub.Status != string(StatusDisabled) && hub.Status != string(StatusArchived) {
			return hf, fmt.Errorf("hub %s: status must be active, disabled or archived", hub.ID)
		}
		if strings.TrimSpace(hub.SecretRef) == "" || len(hub.SecretRef) > 64 {
			return hf, fmt.Errorf("hub %s: secretRef must be 1..64 characters", hub.ID)
		}

		if hub.Status != string(StatusArchived) {
			activeCount++
			cleanURL := strings.ToLower(strings.TrimSuffix(hub.URL, "/"))
			if urls[cleanURL] {
				return hf, fmt.Errorf("duplicate hub URL: %s", hub.URL)
			}
			urls[cleanURL] = true
		}
	}

	if activeCount > 8 {
		return hf, fmt.Errorf("cannot configure more than 8 non-archived hubs (found %d)", activeCount)
	}

	return hf, nil
}

func LoadHubSecretsFile(path string) (HubSecretsFile, error) {
	var sf HubSecretsFile
	f, err := os.Open(path)
	if err != nil {
		return sf, err
	}
	defer f.Close()

	d := json.NewDecoder(io.LimitReader(f, maxConfigBytes))
	d.DisallowUnknownFields()
	if err := d.Decode(&sf); err != nil {
		return sf, err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return sf, errors.New("secrets file must contain exactly one JSON object")
	}

	if sf.SchemaVersion != 1 {
		return sf, errors.New("secrets file schemaVersion must be 1")
	}
	if sf.Secrets == nil {
		return sf, errors.New("secrets map cannot be nil")
	}

	for ref, secret := range sf.Secrets {
		if strings.TrimSpace(ref) == "" || len(ref) > 64 {
			return sf, fmt.Errorf("invalid secret reference: %s", ref)
		}
		if secret == "" || strings.ContainsAny(secret, "\r\n\x00") {
			return sf, fmt.Errorf("invalid secret value for reference: %s", ref)
		}
	}

	return sf, nil
}

func LoadHubsConfig(hubsPath string) (HubsConfig, error) {
	var hc HubsConfig

	// 1. Read hubs.json
	hubsFile, err := LoadHubsFile(hubsPath)
	if err != nil {
		return hc, fmt.Errorf("load hubs file: %w", err)
	}

	// 2. Read secrets
	absHubs, err := filepath.Abs(hubsPath)
	if err != nil {
		return hc, err
	}
	secretsPath := filepath.Join(filepath.Dir(absHubs), hubsFile.SecretsPath)
	secretsFile, err := LoadHubSecretsFile(secretsPath)
	if err != nil {
		return hc, fmt.Errorf("load secrets file: %w", err)
	}

	// 3. Re-read hubs.json revision to guard against mid-write changes
	checkFile, err := LoadHubsFile(hubsPath)
	if err != nil {
		return hc, fmt.Errorf("re-read hubs file: %w", err)
	}
	if checkFile.Revision != hubsFile.Revision {
		return hc, errors.New("hubs file revision changed during read")
	}

	// 4. Resolve secrets
	resolved := make([]ResolvedHub, 0, len(hubsFile.Hubs))
	for _, hub := range hubsFile.Hubs {
		secret, ok := secretsFile.Secrets[hub.SecretRef]
		if !ok {
			return hc, fmt.Errorf("secret reference %s for hub %s not found in secrets file", hub.SecretRef, hub.ID)
		}
		resolved = append(resolved, ResolvedHub{
			ID:        hub.ID,
			Label:     hub.Label,
			URL:       hub.URL,
			Status:    HubStatus(hub.Status),
			SecretRef: hub.SecretRef,
			Secret:    secret,
		})
	}

	hc.Revision = hubsFile.Revision
	hc.Hubs = resolved
	return hc, nil
}
