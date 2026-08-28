package desktop

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestFitWindowBoundsKeepsWindowInsideWorkArea(t *testing.T) {
	tests := []struct {
		name string
		in   application.Rect
		work application.Rect
		want application.Rect
	}{
		{name: "already inside", in: application.Rect{X: 100, Y: 80, Width: 360, Height: 180}, work: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}, want: application.Rect{X: 100, Y: 80, Width: 360, Height: 180}},
		{name: "disconnected left monitor", in: application.Rect{X: -1500, Y: 40, Width: 360, Height: 180}, work: application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}, want: application.Rect{X: 0, Y: 40, Width: 360, Height: 180}},
		{name: "work area smaller than window", in: application.Rect{X: 500, Y: 500, Width: 1280, Height: 800}, work: application.Rect{X: -800, Y: 0, Width: 800, Height: 600}, want: application.Rect{X: -800, Y: 0, Width: 800, Height: 600}},
		{name: "negative origin monitor", in: application.Rect{X: 100, Y: -900, Width: 360, Height: 180}, work: application.Rect{X: 0, Y: -1080, Width: 1920, Height: 1040}, want: application.Rect{X: 100, Y: -900, Width: 360, Height: 180}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := fitWindowBounds(test.in, test.work); got != test.want {
				t.Fatalf("bounds = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestCompactWindowBoundsUsesAdoptedWidthAndHeight(t *testing.T) {
	workArea := application.Rect{X: 0, Y: 0, Width: 1920, Height: 1040}

	if got := compactWindowBounds(application.Rect{X: 100, Y: 100, Width: 900, Height: 500}, workArea, false); got != (application.Rect{X: 100, Y: 100, Width: 360, Height: 600}) {
		t.Fatalf("collapsed bounds = %#v", got)
	}
	if got := compactWindowBounds(application.Rect{X: 100, Y: 100, Width: 360, Height: 500}, workArea, true); got != (application.Rect{X: 100, Y: 100, Width: 360, Height: 500}) {
		t.Fatalf("expanded bounds = %#v", got)
	}
	if got := compactWindowBounds(application.Rect{X: 100, Y: 100, Width: 360, Height: 900}, workArea, true); got.Height != 600 {
		t.Fatalf("expanded height = %d, want 600", got.Height)
	}
}

func TestCompactWindowConstraintsFollowTinyWorkArea(t *testing.T) {
	workArea := application.Rect{X: 0, Y: 0, Width: 300, Height: 100}
	minWidth, minHeight, maxWidth, maxHeight := compactConstraintBounds(workArea, true)
	if minWidth != 300 || maxWidth != 300 || minHeight != 100 || maxHeight != 100 {
		t.Fatalf("tiny work area constraints = %d,%d,%d,%d", minWidth, minHeight, maxWidth, maxHeight)
	}
	bounds := compactWindowBounds(application.Rect{X: 0, Y: 0, Width: 420, Height: 180}, workArea, true)
	if bounds.Width != 300 || bounds.Height != 100 {
		t.Fatalf("tiny work area bounds = %#v", bounds)
	}
}

func TestSnapWindowBoundsAttachesNearWorkAreaEdges(t *testing.T) {
	workArea := application.Rect{X: -1920, Y: 0, Width: 1920, Height: 1080}
	got := snapWindowBounds(application.Rect{X: -1908, Y: 1068, Width: 360, Height: 180}, workArea, 16)
	want := application.Rect{X: -1920, Y: 900, Width: 360, Height: 180}
	if got != want {
		t.Fatalf("snapped bounds = %#v, want %#v", got, want)
	}
}

func TestPlaceWindowWithoutOverlapUsesAvailableEdge(t *testing.T) {
	workArea := application.Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	compact := application.Rect{X: 0, Y: 0, Width: 420, Height: 500}
	preferred := application.Rect{X: 100, Y: 100, Width: 1280, Height: 800}
	got := placeWindowWithoutOverlap(preferred, compact, workArea, 16)
	if rectsOverlap(got, compact) {
		t.Fatalf("placed main window overlaps compact window: %#v", got)
	}
	if got.X != 436 {
		t.Fatalf("placed main x = %d, want 436", got.X)
	}
}

func TestPlaceWindowWithoutOverlapKeepsPreferredPositionWhenClear(t *testing.T) {
	workArea := application.Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	preferred := application.Rect{X: 500, Y: 100, Width: 1280, Height: 800}
	compact := application.Rect{X: 0, Y: 0, Width: 420, Height: 180}
	if got := placeWindowWithoutOverlap(preferred, compact, workArea, 16); got != preferred {
		t.Fatalf("clear preferred bounds = %#v, want %#v", got, preferred)
	}
}

func TestMainWindowRouteAllowlistRejectsArbitraryURLs(t *testing.T) {
	for _, route := range []string{"/overview", "/hubs", "/review", "/settings", "/limits", "/limits/series-1", "/data"} {
		if !validMainRoute(route) {
			t.Fatalf("fixed main route %q was rejected", route)
		}
	}
	for _, route := range []string{"", "https://example.test", "/unknown", "/hubs?secret=value", "/limits/series-1?secret=value", "/limits/series/extra"} {
		if validMainRoute(route) {
			t.Fatalf("arbitrary main route %q was accepted", route)
		}
	}
}

type windowMaintenanceFake struct {
	state DataManagementMaintenanceSnapshot
}

func (f windowMaintenanceFake) GetMaintenanceState() DataManagementMaintenanceSnapshot {
	return f.state
}

func TestWindowControllerBlocksOnlyRestoreApply(t *testing.T) {
	controller := &WindowController{}
	controller.SetMaintenanceReader(windowMaintenanceFake{state: DataManagementMaintenanceSnapshot{Active: true, Operation: "restore", Phase: "restore_apply"}})
	if !controller.restoreApplyActive() {
		t.Fatal("restore apply was not treated as an exit-blocking operation")
	}
	controller.SetMaintenanceReader(windowMaintenanceFake{state: DataManagementMaintenanceSnapshot{Active: true, Operation: "restore", Phase: "restore_validation"}})
	if controller.restoreApplyActive() {
		t.Fatal("restore validation was treated as an exit-blocking operation")
	}
}
