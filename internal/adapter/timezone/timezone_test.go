package timezone

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
	"testing"
	stdtime "time"
)

func TestIANAOptionsAreGeneratedAndLoadable(t *testing.T) {
	for name, value := range map[string]string{
		"CLDRGeneratedTableSHA256": CLDRGeneratedTableSHA256,
		"GoZoneinfoSHA256":         GoZoneinfoSHA256,
	} {
		if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(value) {
			t.Fatalf("%s = %q is not a fixed lowercase SHA-256", name, value)
		}
	}
	options := IANAOptions()
	if len(options) < 500 {
		t.Fatalf("generated IANA options = %d, want the complete zoneinfo list", len(options))
	}
	if !sort.StringsAreSorted(options) {
		t.Fatal("IANA options are not sorted")
	}
	if !IsSupportedIANA("America/New_York") || !IsSupportedIANA("Asia/Tokyo") {
		t.Fatal("common IANA IDs are missing from generated options")
	}
	if IsSupportedIANA("America/NotAZone") {
		t.Fatal("unknown IANA ID is supported")
	}
	for _, id := range options {
		if _, err := LoadLocation(id); err != nil {
			t.Fatalf("generated IANA ID %q cannot be loaded from fixed tzdata: %v", id, err)
		}
	}
	loc, err := LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	instant := stdtime.Date(2024, stdtime.July, 1, 12, 0, 0, 0, stdtime.UTC).In(loc)
	if instant.Location() != loc {
		t.Fatalf("loaded location = %v, want %v", instant.Location(), loc)
	}
	if _, err := LoadLocation("America/NotAZone"); !errors.Is(err, ErrUnsupportedIANA) {
		t.Fatalf("unknown IANA error = %v, want ErrUnsupportedIANA", err)
	}
}

func TestGeneratedTimezoneDataMatchesFixedSources(t *testing.T) {
	goRootOutput, err := exec.CommandContext(t.Context(), "go", "env", "GOROOT").Output()
	if err != nil {
		t.Fatalf("locate Go root: %v", err)
	}
	zoneinfoPath := filepath.Join(strings.TrimSpace(string(goRootOutput)), "lib", "time", "zoneinfo.zip")
	zoneinfo, err := os.ReadFile(zoneinfoPath)
	if err != nil {
		t.Fatal(err)
	}
	zoneinfoHash := sha256.Sum256(zoneinfo)
	if got := hex.EncodeToString(zoneinfoHash[:]); got != GoZoneinfoSHA256 {
		t.Fatalf("zoneinfo.zip SHA-256 = %s, want %s", got, GoZoneinfoSHA256)
	}
	archive, err := zip.OpenReader(zoneinfoPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := archive.Close(); err != nil {
			t.Errorf("close zoneinfo.zip: %v", err)
		}
	}()
	zones := make([]string, 0, len(archive.File))
	for _, file := range archive.File {
		if !file.FileInfo().IsDir() {
			zones = append(zones, file.Name)
		}
	}
	sort.Strings(zones)
	if !slices.Equal(zones, IANAOptions()) {
		t.Fatal("iana_zones_generated.go differs from the fixed Go zoneinfo.zip")
	}

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate timezone test")
	}
	mapping, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "windows_to_iana_generated.go"))
	if err != nil {
		t.Fatal(err)
	}
	mappingHash := sha256.Sum256(mapping)
	if got := hex.EncodeToString(mappingHash[:]); got != CLDRGeneratedTableSHA256 {
		t.Fatalf("windows_to_iana_generated.go SHA-256 = %s, want %s", got, CLDRGeneratedTableSHA256)
	}
}

func TestWindowsIDUsesOnlyTerritory001Candidate(t *testing.T) {
	tests := []struct {
		windows string
		iana    string
	}{
		{windows: "Pacific Standard Time", iana: "America/Los_Angeles"},
		{windows: "Tokyo Standard Time", iana: "Asia/Tokyo"},
		{windows: "India Standard Time", iana: "Asia/Kolkata"},
	}
	for _, test := range tests {
		got, ok := WindowsIDToIANA(test.windows)
		if !ok || got != test.iana {
			t.Errorf("WindowsIDToIANA(%q) = %q, %v; want %q, true", test.windows, got, ok, test.iana)
		}
		options := WindowsIDToIANAOptions(test.windows)
		if len(options) != 1 || options[0] != test.iana {
			t.Errorf("WindowsIDToIANAOptions(%q) = %v; want [%q]", test.windows, options, test.iana)
		}
	}
	for _, windows := range []string{"unknown Windows zone", ""} {
		if got, ok := WindowsIDToIANA(windows); ok || got != "" {
			t.Errorf("unknown Windows ID %q mapped to %q, %v", windows, got, ok)
		}
		if options := WindowsIDToIANAOptions(windows); len(options) != 0 {
			t.Errorf("unknown Windows ID %q returned candidates %v", windows, options)
		}
	}
	for windows, iana := range windowsToIANA {
		if !IsSupportedIANA(iana) {
			t.Errorf("generated Windows mapping %q points to missing IANA ID %q", windows, iana)
		}
	}
}
