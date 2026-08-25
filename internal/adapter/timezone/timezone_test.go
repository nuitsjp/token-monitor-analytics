package timezone

import (
	"errors"
	"regexp"
	"sort"
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
