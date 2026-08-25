package domain

import (
	"errors"
	"fmt"
	stdtime "time"
)

// DisplayTimeZone is the value used by the display layer. A candidate is kept
// separate from a confirmed value so that merely showing an OS suggestion
// cannot change the display timezone.
type DisplayTimeZone struct {
	IANA      string
	Confirmed bool
}

// NewDisplayTimeZone creates an unconfirmed candidate. Call Confirm only
// after the user explicitly accepts the candidate or selects another IANA ID.
func NewDisplayTimeZone(iana string) DisplayTimeZone {
	return DisplayTimeZone{IANA: iana}
}

// Confirm returns a value that may be persisted as the display timezone.
func (z DisplayTimeZone) Confirm() DisplayTimeZone {
	z.Confirmed = z.IANA != ""
	return z
}

// SavedIANA returns the selected IANA ID only after explicit confirmation.
func (z DisplayTimeZone) SavedIANA() (string, bool) {
	if !z.Confirmed || z.IANA == "" {
		return "", false
	}
	return z.IANA, true
}

// ErrNonexistentLocalTime is returned for a wall-clock time skipped by a DST
// transition.
var ErrNonexistentLocalTime = errors.New("nonexistent local time")

// ErrAmbiguousLocalTime is returned when a wall-clock time occurs twice and
// no offset was selected.
var ErrAmbiguousLocalTime = errors.New("ambiguous local time requires an offset")

// ErrInvalidLocalTimeOffset is returned when the selected offset is not valid
// for the supplied wall-clock time.
var ErrInvalidLocalTimeOffset = errors.New("invalid local time offset")

// LocalTimeCandidate is one instant represented by a local wall-clock value.
// OffsetSeconds is the UTC offset that must be selected when the value is
// ambiguous.
type LocalTimeCandidate struct {
	Instant       stdtime.Time
	OffsetSeconds int
	Abbreviation  string
}

// LocalTimeCandidates resolves the wall-clock fields in local using loc. The
// input's location and offset are ignored; its calendar and clock fields are
// used as a wall-clock value. An empty result means that the local time does
// not exist. The returned candidates are ordered by their UTC instant.
func LocalTimeCandidates(local stdtime.Time, loc *stdtime.Location) []LocalTimeCandidate {
	if loc == nil {
		return nil
	}
	year, month, day := local.Date()
	hour, minute, second := local.Clock()
	nsec := local.Nanosecond()
	wall := stdtime.Date(year, month, day, hour, minute, second, nsec, stdtime.UTC)

	// A transition's old and new offsets are normally close to the requested
	// wall time. Sampling a bounded window gives us all offsets without relying
	// on time.Date's undocumented choice at a fall-back transition.
	base := stdtime.Date(year, month, day, hour, minute, second, nsec, loc)
	offsets := make(map[int]struct{}, 8)
	for delta := -72 * stdtime.Hour; delta <= 72*stdtime.Hour; delta += 15 * stdtime.Minute {
		_, offset := base.Add(delta).In(loc).Zone()
		offsets[offset] = struct{}{}
	}
	// Include the offset at the nominal wall value as well. This matters for
	// fixed-offset locations and for transitions wider than one day.
	_, offset := base.Zone()
	offsets[offset] = struct{}{}

	candidates := make([]LocalTimeCandidate, 0, len(offsets))
	for offset := range offsets {
		instant := wall.Add(-stdtime.Duration(offset) * stdtime.Second).UTC()
		actual := instant.In(loc)
		if actual.Year() != year || actual.Month() != month || actual.Day() != day ||
			actual.Hour() != hour || actual.Minute() != minute || actual.Second() != second ||
			actual.Nanosecond() != nsec {
			continue
		}
		name, actualOffset := actual.Zone()
		candidates = append(candidates, LocalTimeCandidate{
			Instant:       instant,
			OffsetSeconds: actualOffset,
			Abbreviation:  name,
		})
	}

	for i := 1; i < len(candidates); i++ {
		for j := i; j > 0 && candidates[j].Instant.Before(candidates[j-1].Instant); j-- {
			candidates[j], candidates[j-1] = candidates[j-1], candidates[j]
		}
	}
	return candidates
}

// ResolveLocalTime converts a wall-clock value into an instant. A nil offset
// is accepted only when the local time has one valid interpretation. For an
// ambiguous time, offsetSeconds must match one of LocalTimeCandidates' values.
func ResolveLocalTime(local stdtime.Time, loc *stdtime.Location, offsetSeconds *int) (stdtime.Time, error) {
	if loc == nil {
		return stdtime.Time{}, fmt.Errorf("resolve local time: nil location")
	}
	candidates := LocalTimeCandidates(local, loc)
	switch len(candidates) {
	case 0:
		return stdtime.Time{}, fmt.Errorf("%w: %s in %s", ErrNonexistentLocalTime, local.Format("2006-01-02 15:04:05"), loc)
	case 1:
		if offsetSeconds != nil && *offsetSeconds != candidates[0].OffsetSeconds {
			return stdtime.Time{}, fmt.Errorf("%w: want %d, valid %d", ErrInvalidLocalTimeOffset, *offsetSeconds, candidates[0].OffsetSeconds)
		}
		return candidates[0].Instant, nil
	default:
		if offsetSeconds == nil {
			return stdtime.Time{}, fmt.Errorf("%w: %s in %s", ErrAmbiguousLocalTime, local.Format("2006-01-02 15:04:05"), loc)
		}
		for _, candidate := range candidates {
			if candidate.OffsetSeconds == *offsetSeconds {
				return candidate.Instant, nil
			}
		}
		return stdtime.Time{}, fmt.Errorf("%w: want %d", ErrInvalidLocalTimeOffset, *offsetSeconds)
	}
}

// ConvertInstant converts an instant to a display location without changing
// the instant. The returned value remains equal to instant by Time.Equal.
func ConvertInstant(instant stdtime.Time, loc *stdtime.Location) (stdtime.Time, error) {
	if loc == nil {
		return stdtime.Time{}, fmt.Errorf("convert instant: nil location")
	}
	return instant.UTC().In(loc), nil
}

// LocalDayBounds returns the UTC instants of local midnight at the beginning
// of date and the following local midnight. The duration therefore remains
// 23 or 25 hours across DST transitions; it is never normalized to 24 hours.
func LocalDayBounds(date stdtime.Time, loc *stdtime.Location) (start, end stdtime.Time, err error) {
	if loc == nil {
		return stdtime.Time{}, stdtime.Time{}, fmt.Errorf("local day bounds: nil location")
	}
	year, month, day := date.In(loc).Date()
	start, err = ResolveLocalTime(stdtime.Date(year, month, day, 0, 0, 0, 0, stdtime.UTC), loc, nil)
	if err != nil {
		return stdtime.Time{}, stdtime.Time{}, err
	}
	next := stdtime.Date(year, month, day+1, 0, 0, 0, 0, stdtime.UTC)
	end, err = ResolveLocalTime(next, loc, nil)
	if err != nil {
		return stdtime.Time{}, stdtime.Time{}, err
	}
	return start, end, nil
}

// MondayWeekStart returns Monday 00:00 in the same location as the supplied
// local date. Its UTC duration to the following week naturally accounts for
// DST changes.
func MondayWeekStart(local stdtime.Time, loc *stdtime.Location) (stdtime.Time, error) {
	if loc == nil {
		return stdtime.Time{}, fmt.Errorf("monday week start: nil location")
	}
	value := local.In(loc)
	weekdayOffset := (int(value.Weekday()) + 6) % 7
	date := stdtime.Date(value.Year(), value.Month(), value.Day()-weekdayOffset, 0, 0, 0, 0, stdtime.UTC)
	start, err := ResolveLocalTime(date, loc, nil)
	if err != nil {
		return stdtime.Time{}, err
	}
	return start.In(loc), nil
}
