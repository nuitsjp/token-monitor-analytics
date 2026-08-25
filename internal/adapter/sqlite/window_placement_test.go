package sqlite

import (
	"context"
	"path/filepath"
	"testing"
)

func TestWindowPlacementRoundTripAndSeparation(t *testing.T) {
	lifecycle := &Lifecycle{}
	if err := lifecycle.Open(context.Background(), filepath.Join(t.TempDir(), "placement.sqlite3")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lifecycle.Close() })
	if _, found, err := lifecycle.GetWindowPlacement(context.Background(), "compact"); err != nil || found {
		t.Fatalf("initial placement found = %v, err = %v", found, err)
	}
	want := WindowPlacement{X: -1200, Y: 40, Width: 360, Height: 180, DPI: 144, Monitor: `\\.\DISPLAY2`}
	if err := lifecycle.SaveWindowPlacement(context.Background(), "compact", want); err != nil {
		t.Fatal(err)
	}
	got, found, err := lifecycle.GetWindowPlacement(context.Background(), "compact")
	if err != nil || !found {
		t.Fatalf("saved placement found = %v, err = %v", found, err)
	}
	if got != want {
		t.Fatalf("placement = %#v, want %#v", got, want)
	}
	if _, found, err := lifecycle.GetWindowPlacement(context.Background(), "main"); err != nil || found {
		t.Fatalf("main placement found = %v, err = %v", found, err)
	}
}
