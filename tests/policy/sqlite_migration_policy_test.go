package policy

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
)

var migrationFilename = regexp.MustCompile(`^(\d{5})_[a-z0-9_]+\.sql$`)
var gooseMarker = regexp.MustCompile(`(?m)^\s*--\s*\+goose\s+(Up|Down)\s*$`)

func TestSQLiteMigrationsAreContiguousAndEndAtCurrentSchemaVersion(t *testing.T) {
	entries := migrationEntries(t)
	if len(entries) == 0 {
		t.Fatal("no SQLite migrations found")
	}

	numbers := make([]int, 0, len(entries))
	for _, entry := range entries {
		match := migrationFilename.FindStringSubmatch(entry.Name())
		if match == nil {
			t.Fatalf("migration filename %q does not use the five-digit numbered format", entry.Name())
		}
		number, err := strconv.Atoi(match[1])
		if err != nil {
			t.Fatalf("parse migration number from %q: %v", entry.Name(), err)
		}
		numbers = append(numbers, number)
	}
	sort.Ints(numbers)

	for index, number := range numbers {
		want := index + 1
		if number != want {
			t.Fatalf("migration sequence at position %d = %d, want %d", index, number, want)
		}
	}
	if got := int64(numbers[len(numbers)-1]); got != sqliteadapter.CurrentSchemaVersion {
		t.Fatalf("maximum migration number = %d, want CurrentSchemaVersion %d", got, sqliteadapter.CurrentSchemaVersion)
	}
}

func TestSQLiteMigrationsHaveOneOrderedUpAndDownSection(t *testing.T) {
	for _, entry := range migrationEntries(t) {
		contents, err := os.ReadFile(filepath.Join(migrationsDirectory(t), entry.Name()))
		if err != nil {
			t.Fatalf("read migration %s: %v", entry.Name(), err)
		}
		matches := gooseMarker.FindAllStringSubmatchIndex(string(contents), -1)
		if len(matches) != 2 {
			t.Fatalf("migration %s has %d goose sections, want exactly one Up and one Down", entry.Name(), len(matches))
		}
		first := string(contents[matches[0][2]:matches[0][3]])
		second := string(contents[matches[1][2]:matches[1][3]])
		if first != "Up" || second != "Down" {
			t.Fatalf("migration %s sections = %q then %q, want Up then Down", entry.Name(), first, second)
		}
		upEnd := matches[0][1]
		downStart := matches[1][0]
		if strings.TrimSpace(string(contents[upEnd:downStart])) == "" {
			t.Fatalf("migration %s has an empty Up section", entry.Name())
		}
		if strings.TrimSpace(string(contents[matches[1][1]:])) == "" {
			t.Fatalf("migration %s has an empty Down section", entry.Name())
		}
	}
}

func migrationEntries(t *testing.T) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(migrationsDirectory(t))
	if err != nil {
		t.Fatalf("read migration directory: %v", err)
	}
	files := make([]os.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			files = append(files, entry)
		}
	}
	return files
}

func migrationsDirectory(t *testing.T) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate migration policy test")
	}
	return filepath.Join(filepath.Dir(currentFile), "..", "..", "internal", "adapter", "sqlite", "migrations")
}
