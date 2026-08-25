package backupzip

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"token-monitor-analytics/internal/domain"
)

func TestManifestRoundTripIsStrictAndBOMFree(t *testing.T) {
	manifest := testManifest()
	encoded, err := marshalManifest(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	if bytes.HasPrefix(encoded, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatal("manifest unexpectedly has a BOM")
	}
	got, err := parseManifest(encoded)
	if err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if !sameManifest(got, manifest) {
		t.Fatalf("manifest = %#v, want %#v", got, manifest)
	}
}

func TestManifestRejectsBOMUnknownDuplicateAndTrailingJSON(t *testing.T) {
	manifestBytes, err := marshalManifest(testManifest())
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	tests := []struct {
		name string
		data []byte
	}{
		{name: "BOM", data: append([]byte{0xEF, 0xBB, 0xBF}, manifestBytes...)},
		{name: "unknown", data: []byte(strings.Replace(string(manifestBytes), `"appVersion":"test"`, `"appVersion":"test","extra":1`, 1))},
		{name: "duplicate", data: []byte(strings.Replace(string(manifestBytes), `"appVersion":"test"`, `"appVersion":"test","appVersion":"other"`, 1))},
		{name: "trailing", data: append(append([]byte(nil), manifestBytes...), []byte(` true`)...)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := parseManifest(test.data); err == nil {
				t.Fatal("parse unexpectedly succeeded")
			}
		})
	}
}

func TestManifestRejectsNonUTCCreatedAt(t *testing.T) {
	manifest := testManifest()
	manifest.CreatedAt = time.Date(2026, 8, 26, 12, 0, 0, 0, time.FixedZone("JST", 9*60*60))
	if _, err := marshalManifest(manifest); err == nil {
		t.Fatal("marshal unexpectedly accepted non-UTC createdAt")
	}
}

func testManifest() domain.BackupManifest {
	return domain.BackupManifest{
		FormatVersion: domain.BackupFormatVersion,
		SchemaVersion: 12,
		AppVersion:    "test",
		CreatedAt:     time.Date(2026, 8, 26, 3, 4, 5, 6, time.UTC),
		Database: domain.BackupDatabaseManifest{
			Path:      "data.sqlite3",
			SizeBytes: 4,
			SHA256:    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		},
	}
}
