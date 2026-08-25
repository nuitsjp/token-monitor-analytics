package sqlite

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"token-monitor-analytics/internal/domain"
)

const restoreJournalVersion = 1

type restoreJournalStage string

const (
	restoreStagePrepared         restoreJournalStage = "prepared"
	restoreStageOriginalMoved    restoreJournalStage = "original_moved"
	restoreStageReplacementMoved restoreJournalStage = "replacement_moved"
	restoreStageReopened         restoreJournalStage = "reopened"
	restoreStageAuditWritten     restoreJournalStage = "audit_written"
	restoreStageVerified         restoreJournalStage = "verified"
	restoreStageCommitted        restoreJournalStage = "committed"
)

type restoreJournal struct {
	JournalVersion      int                 `json:"journalVersion"`
	Stage               restoreJournalStage `json:"stage"`
	OperationID         string              `json:"operationID"`
	ArtifactSHA256      string              `json:"artifactSha256"`
	BackupFormatVersion int                 `json:"backupFormatVersion"`
	SchemaVersion       int64               `json:"schemaVersion"`
	RestoredAt          string              `json:"restoredAt"`
	AuditID             string              `json:"auditID"`
	OriginalWAL         bool                `json:"originalWal"`
	OriginalSHM         bool                `json:"originalShm"`
}

var restoreJournalToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var restoreJournalSHA = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (j restoreJournal) validate() error {
	if j.JournalVersion != restoreJournalVersion {
		return errors.New("unsupported restore journal version")
	}
	if !validRestoreJournalStage(j.Stage) {
		return errors.New("unknown restore journal stage")
	}
	if !restoreJournalToken.MatchString(j.OperationID) || !restoreJournalToken.MatchString(j.AuditID) {
		return errors.New("restore journal contains an invalid identifier")
	}
	if !restoreJournalSHA.MatchString(j.ArtifactSHA256) {
		return errors.New("restore journal contains an invalid artifact SHA-256")
	}
	if j.BackupFormatVersion != domain.BackupFormatVersion || j.SchemaVersion != CurrentSchemaVersion {
		return errors.New("restore journal contains an unsupported version")
	}
	parsed, err := time.Parse(time.RFC3339Nano, j.RestoredAt)
	if err != nil || !strings.HasSuffix(j.RestoredAt, "Z") || parsed.Location() != time.UTC {
		return errors.New("restore journal contains an invalid UTC time")
	}
	return nil
}

func validRestoreJournalStage(stage restoreJournalStage) bool {
	switch stage {
	case restoreStagePrepared, restoreStageOriginalMoved, restoreStageReplacementMoved, restoreStageReopened, restoreStageAuditWritten, restoreStageVerified, restoreStageCommitted:
		return true
	default:
		return false
	}
}

func writeRestoreJournal(paths restorePaths, journal restoreJournal) error {
	if err := journal.validate(); err != nil {
		return err
	}
	encoded, err := json.Marshal(journal)
	if err != nil {
		return errors.New("encode restore journal")
	}
	if err := removeRestoreFileIfPresent(paths.root, paths.journalTemporary); err != nil {
		return fmt.Errorf("remove stale restore journal temporary file: %w", err)
	}
	file, err := os.OpenFile(paths.journalTemporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return errors.New("create restore journal temporary file")
	}
	writeErr := writeAll(file, encoded)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		_ = removeRestoreFileIfPresent(paths.root, paths.journalTemporary)
		return errors.New("flush restore journal temporary file")
	}
	if err := replaceRestoreJournal(paths.journalTemporary, paths.journal); err != nil {
		return errors.New("atomically replace restore journal")
	}
	if err := syncRestoreDirectory(paths.root); err != nil {
		return errors.New("flush restore journal directory")
	}
	return nil
}

func readRestoreJournal(path string) (restoreJournal, error) {
	file, err := os.Open(path)
	if err != nil {
		return restoreJournal{}, err
	}
	defer file.Close()
	contents, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil || len(contents) > 64*1024 {
		return restoreJournal{}, errors.New("restore journal is unreadable")
	}
	if bytes.HasPrefix(contents, []byte{0xEF, 0xBB, 0xBF}) || !utf8.Valid(contents) {
		return restoreJournal{}, errors.New("restore journal encoding is invalid")
	}
	if err := scanRestoreJournalJSON(contents); err != nil {
		return restoreJournal{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var journal restoreJournal
	if err := decoder.Decode(&journal); err != nil {
		return restoreJournal{}, errors.New("restore journal JSON is invalid")
	}
	if err := journal.validate(); err != nil {
		return restoreJournal{}, err
	}
	return journal, nil
}

func scanRestoreJournalJSON(contents []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("restore journal root is invalid")
	}
	seen := make(map[string]struct{})
	expected := map[string]struct{}{
		"journalVersion": {}, "stage": {}, "operationID": {}, "artifactSha256": {},
		"backupFormatVersion": {}, "schemaVersion": {}, "restoredAt": {}, "auditID": {},
		"originalWal": {}, "originalShm": {},
	}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return errors.New("restore journal JSON is invalid")
		}
		key, ok := keyToken.(string)
		if !ok {
			return errors.New("restore journal key is invalid")
		}
		if _, exists := seen[key]; exists {
			return errors.New("restore journal contains a duplicate key")
		}
		if _, exists := expected[key]; !exists {
			return errors.New("restore journal contains an unknown key")
		}
		seen[key] = struct{}{}
		var ignored json.RawMessage
		if err := decoder.Decode(&ignored); err != nil {
			return errors.New("restore journal JSON is invalid")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return errors.New("restore journal JSON is invalid")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("restore journal contains trailing data")
	}
	if len(seen) != len(expected) {
		return errors.New("restore journal is missing a required key")
	}
	return nil
}

func writeAll(file *os.File, contents []byte) error {
	for len(contents) > 0 {
		written, err := file.Write(contents)
		if err != nil {
			return err
		}
		contents = contents[written:]
	}
	return nil
}
