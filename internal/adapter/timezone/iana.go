package timezone

import (
	"errors"
	"fmt"
	"sort"
	stdtime "time"

	_ "time/tzdata"
)

// The generated tables are tied to the toolchain and CLDR release used for
// the Windows desktop build. Runtime network access and OS zone lists are not
// part of this adapter.
const (
	CLDRVersion   = "48.2"
	CLDRTerritory = "001"
	CLDRSourceURL = "https://github.com/unicode-org/cldr/blob/release-48-2/common/supplemental/windowsZones.xml"
	GoToolchain   = "go1.26.7"
	// CLDRGeneratedTableSHA256 is the hash of the committed generated mapping
	// artifact. It makes an accidental table edit visible without any runtime
	// source download.
	CLDRGeneratedTableSHA256 = "b32fc437f075fbd15dc74e6da478164d89b85297694d0b903552d0607e85ddb0"
	GoZoneinfoSHA256         = "8f55634d05f8bca1f7bc7c69c5933428c69357e0bdf565e5ba224e3f88ff12e8"
)

var ErrUnsupportedIANA = errors.New("unsupported IANA timezone")

// IANAOptions returns a sorted copy of the IANA identifiers generated from
// Go 1.26.7's zoneinfo.zip. The caller may safely modify the returned slice.
func IANAOptions() []string {
	options := append([]string(nil), generatedIANAZones...)
	sort.Strings(options)
	return options
}

// IsSupportedIANA reports whether id is one of the committed generated IDs.
func IsSupportedIANA(id string) bool {
	_, ok := generatedIANAZoneSet[id]
	return ok
}

// LoadLocation validates the ID against the committed list and loads it from
// the embedded time/tzdata copy. Unknown IDs are rejected without guessing or
// falling back to the operating system's timezone list.
func LoadLocation(id string) (*stdtime.Location, error) {
	if !IsSupportedIANA(id) {
		return nil, fmt.Errorf("%w: %q", ErrUnsupportedIANA, id)
	}
	loc, err := stdtime.LoadLocation(id)
	if err != nil {
		return nil, fmt.Errorf("load IANA timezone %q: %w", id, err)
	}
	return loc, nil
}

// WindowsIDToIANA returns the CLDR 48.2 territory-001 candidate. An unknown
// Windows ID deliberately returns no candidate; callers must wait for an
// explicit IANA selection.
func WindowsIDToIANA(windowsID string) (string, bool) {
	iana, ok := windowsToIANA[windowsID]
	return iana, ok
}

// WindowsIDToIANAOptions returns zero or one territory-001 candidate. It is a
// slice to make the no-candidate state explicit to UI adapters.
func WindowsIDToIANAOptions(windowsID string) []string {
	iana, ok := WindowsIDToIANA(windowsID)
	if !ok {
		return nil
	}
	return []string{iana}
}
