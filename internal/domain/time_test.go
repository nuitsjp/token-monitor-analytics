package domain

import (
	"errors"
	"sort"
	"testing"
	stdtime "time"

	_ "time/tzdata"
)

func TestDisplayTimeZoneRequiresExplicitConfirmation(t *testing.T) {
	candidate := NewDisplayTimeZone("Asia/Tokyo")
	if candidate.Confirmed {
		t.Fatal("OS candidate was confirmed without user action")
	}
	if saved, ok := candidate.SavedIANA(); ok || saved != "" {
		t.Fatalf("unconfirmed candidate was persisted: %q, %v", saved, ok)
	}
	confirmed := candidate.Confirm()
	if !confirmed.Confirmed {
		t.Fatal("explicit confirmation was not retained")
	}
	if saved, ok := confirmed.SavedIANA(); !ok || saved != "Asia/Tokyo" {
		t.Fatalf("confirmed timezone = %q, %v", saved, ok)
	}
}

func TestQLTime01DisplayZoneKeepsStoredInstantsAndPeriodBoundaries(t *testing.T) {
	t.Run("QL-TIME-01 selected IANA zone changes presentation only", func(t *testing.T) {
		selected := NewDisplayTimeZone("Asia/Tokyo").Confirm()
		if saved, ok := selected.SavedIANA(); !ok || saved != "Asia/Tokyo" {
			t.Fatalf("selected display timezone = %q, %v", saved, ok)
		}
		saved, _ := selected.SavedIANA()
		loc, err := stdtime.LoadLocation(saved)
		if err != nil {
			t.Fatal(err)
		}
		storedObservation := stdtime.Date(2026, stdtime.August, 25, 15, 0, 0, 0, stdtime.UTC)
		displayedObservation, err := ConvertInstant(storedObservation, loc)
		if err != nil {
			t.Fatal(err)
		}
		if !displayedObservation.Equal(storedObservation) || displayedObservation.Format("2006-01-02 15:04") != "2026-08-26 00:00" {
			t.Fatalf("displayed observation = %s, want same instant at Tokyo midnight", displayedObservation)
		}
		periodStart := stdtime.Date(2026, stdtime.August, 1, 0, 0, 0, 0, stdtime.UTC)
		periodEnd := stdtime.Date(2026, stdtime.September, 1, 0, 0, 0, 0, stdtime.UTC)
		displayedStart, err := ConvertInstant(periodStart, loc)
		if err != nil {
			t.Fatal(err)
		}
		displayedEnd, err := ConvertInstant(periodEnd, loc)
		if err != nil {
			t.Fatal(err)
		}
		if !displayedStart.Equal(periodStart) || !displayedEnd.Equal(periodEnd) || displayedEnd.Sub(displayedStart) != periodEnd.Sub(periodStart) {
			t.Fatalf("period boundaries changed: start=%s end=%s", displayedStart, displayedEnd)
		}
	})
}

func TestConvertInstantDoesNotChangeUTCInstant(t *testing.T) {
	loc, err := stdtime.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	instant := stdtime.Date(2024, stdtime.July, 1, 12, 34, 56, 123, stdtime.UTC)
	converted, err := ConvertInstant(instant, loc)
	if err != nil {
		t.Fatal(err)
	}
	if !converted.Equal(instant) {
		t.Fatalf("converted instant %s does not equal %s", converted, instant)
	}
	if converted.Location() != loc {
		t.Fatalf("converted location = %v, want %v", converted.Location(), loc)
	}
}

func TestMondayWeekStartUsesMondayAndLocalCalendar(t *testing.T) {
	loc, err := stdtime.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	start, err := MondayWeekStart(stdtime.Date(2024, 1, 17, 18, 0, 0, 0, loc), loc)
	if err != nil {
		t.Fatal(err)
	}
	local := start.In(loc)
	year, month, day := local.Date()
	if local.Weekday() != stdtime.Monday || year != 2024 || month != stdtime.January || day != 15 {
		t.Fatalf("week start = %s", local)
	}
	if local.Hour() != 0 || local.Minute() != 0 || local.Second() != 0 {
		t.Fatalf("week start is not local midnight: %s", local)
	}
}

func TestLocalDayBoundsKeep23And25HourDays(t *testing.T) {
	loc, err := stdtime.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		date stdtime.Time
		want stdtime.Duration
	}{
		{name: "spring forward", date: stdtime.Date(2024, stdtime.March, 10, 12, 0, 0, 0, loc), want: 23 * stdtime.Hour},
		{name: "fall back", date: stdtime.Date(2024, stdtime.November, 3, 12, 0, 0, 0, loc), want: 25 * stdtime.Hour},
	} {
		t.Run(test.name, func(t *testing.T) {
			start, end, err := LocalDayBounds(test.date, loc)
			if err != nil {
				t.Fatal(err)
			}
			if got := end.Sub(start); got != test.want {
				t.Fatalf("day duration = %s, want %s", got, test.want)
			}
		})
	}
}

func TestResolveLocalTimeRejectsSkippedWallClockTime(t *testing.T) {
	loc, err := stdtime.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	wall := stdtime.Date(2024, stdtime.March, 10, 2, 30, 0, 0, stdtime.UTC)
	if got := LocalTimeCandidates(wall, loc); len(got) != 0 {
		t.Fatalf("skipped wall-clock time has %d candidates: %#v", len(got), got)
	}
	if _, err := ResolveLocalTime(wall, loc, nil); !errors.Is(err, ErrNonexistentLocalTime) {
		t.Fatalf("ResolveLocalTime error = %v, want ErrNonexistentLocalTime", err)
	}
}

func TestResolveLocalTimeRequiresAndUsesSelectedOffset(t *testing.T) {
	loc, err := stdtime.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	wall := stdtime.Date(2024, stdtime.November, 3, 1, 30, 0, 0, stdtime.UTC)
	candidates := LocalTimeCandidates(wall, loc)
	if len(candidates) != 2 {
		t.Fatalf("ambiguous wall-clock candidates = %d, want 2: %#v", len(candidates), candidates)
	}
	offsets := []int{candidates[0].OffsetSeconds, candidates[1].OffsetSeconds}
	sort.Ints(offsets)
	if offsets[0] != -5*60*60 || offsets[1] != -4*60*60 {
		t.Fatalf("ambiguous offsets = %v, want [-18000 -14400]", offsets)
	}
	if _, err := ResolveLocalTime(wall, loc, nil); !errors.Is(err, ErrAmbiguousLocalTime) {
		t.Fatalf("ResolveLocalTime error = %v, want ErrAmbiguousLocalTime", err)
	}
	for _, candidate := range candidates {
		offset := candidate.OffsetSeconds
		resolved, err := ResolveLocalTime(wall, loc, &offset)
		if err != nil {
			t.Fatalf("resolve offset %d: %v", offset, err)
		}
		if !resolved.Equal(candidate.Instant) {
			t.Fatalf("offset %d resolved to %s, want %s", offset, resolved, candidate.Instant)
		}
		if got := resolved.In(loc).Format("2006-01-02 15:04:05"); got != "2024-11-03 01:30:00" {
			t.Fatalf("offset %d roundtrip = %s", offset, got)
		}
	}
}
