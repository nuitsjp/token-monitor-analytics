package backupzip

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"token-monitor-analytics/internal/domain"
)

type manifestJSON struct {
	FormatVersion int                  `json:"formatVersion"`
	SchemaVersion int64                `json:"schemaVersion"`
	AppVersion    string               `json:"appVersion"`
	CreatedAt     string               `json:"createdAt"`
	Database      manifestDatabaseJSON `json:"database"`
}

type manifestDatabaseJSON struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

func marshalManifest(manifest domain.BackupManifest) ([]byte, error) {
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	return json.Marshal(manifestJSON{
		FormatVersion: manifest.FormatVersion,
		SchemaVersion: manifest.SchemaVersion,
		AppVersion:    manifest.AppVersion,
		CreatedAt:     manifest.CreatedAt.UTC().Format(time.RFC3339Nano),
		Database: manifestDatabaseJSON{
			Path:      manifest.Database.Path,
			SizeBytes: manifest.Database.SizeBytes,
			SHA256:    manifest.Database.SHA256,
		},
	})
}

func parseManifest(data []byte) (domain.BackupManifest, error) {
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		return domain.BackupManifest{}, errors.New("manifest must not contain a UTF-8 BOM")
	}
	if err := scanJSONKeys(data); err != nil {
		return domain.BackupManifest{}, fmt.Errorf("manifest JSON: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var raw manifestJSON
	if err := decoder.Decode(&raw); err != nil {
		return domain.BackupManifest{}, fmt.Errorf("decode manifest: %w", err)
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return domain.BackupManifest{}, fmt.Errorf("manifest trailing JSON: %w", err)
		}
		return domain.BackupManifest{}, fmt.Errorf("manifest has trailing token %v", token)
	}
	createdAt, err := time.Parse(time.RFC3339Nano, raw.CreatedAt)
	if err != nil || !strings.HasSuffix(raw.CreatedAt, "Z") {
		return domain.BackupManifest{}, errors.New("manifest createdAt must be RFC 3339 UTC")
	}
	manifest := domain.BackupManifest{
		FormatVersion: raw.FormatVersion,
		SchemaVersion: raw.SchemaVersion,
		AppVersion:    raw.AppVersion,
		CreatedAt:     createdAt,
		Database: domain.BackupDatabaseManifest{
			Path:      raw.Database.Path,
			SizeBytes: raw.Database.SizeBytes,
			SHA256:    raw.Database.SHA256,
		},
	}
	if err := manifest.Validate(); err != nil {
		return domain.BackupManifest{}, err
	}
	return manifest, nil
}

func scanJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := scanJSONValue(decoder); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err != nil {
			return err
		}
		return fmt.Errorf("trailing token %v", token)
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return errors.New("object key is not a string")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("duplicate object key %q", key)
				}
				seen[key] = struct{}{}
				if err := scanJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return errors.New("object is not closed")
			}
		case '[':
			for decoder.More() {
				if err := scanJSONValue(decoder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return errors.New("array is not closed")
			}
		default:
			return fmt.Errorf("unexpected delimiter %q", delimiter)
		}
	}
	return nil
}
