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
