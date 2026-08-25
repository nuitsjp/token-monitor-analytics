package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const BackupFormatVersion = 1

type BackupDatabaseManifest struct {
	Path      string
	SizeBytes int64
	SHA256    string
}

type BackupManifest struct {
	FormatVersion int
	SchemaVersion int64
	AppVersion    string
	CreatedAt     time.Time
	Database      BackupDatabaseManifest
}

type BackupArtifact struct {
	Path           string
	SizeBytes      int64
	ArtifactSHA256 string
	CreatedAt      time.Time
	Warning        string
}

func (m BackupManifest) Validate() error {
	if m.FormatVersion != BackupFormatVersion {
		return fmt.Errorf("unsupported backup format version %d", m.FormatVersion)
	}
	if m.SchemaVersion <= 0 {
		return errors.New("backup schema version must be positive")
	}
	if strings.TrimSpace(m.AppVersion) == "" {
		return errors.New("backup app version is required")
	}
	if m.CreatedAt.IsZero() || m.CreatedAt.Location() != time.UTC || !strings.HasSuffix(m.CreatedAt.Format(time.RFC3339Nano), "Z") {
		return errors.New("backup createdAt must be a UTC timestamp")
	}
	if m.Database.Path != "data.sqlite3" {
		return errors.New("backup database path must be data.sqlite3")
	}
	if m.Database.SizeBytes <= 0 {
		return errors.New("backup database size must be positive")
	}
	if !sha256Pattern.MatchString(m.Database.SHA256) {
		return errors.New("backup database sha256 must be 64 lowercase hexadecimal characters")
	}
	return nil
}

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
