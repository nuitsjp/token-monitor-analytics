package desktop

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/url"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	sqliteadapter "token-monitor-analytics/internal/adapter/sqlite"
)

type WindowService struct {
	controller *WindowController
}

type WindowController struct {
	app *application.App

	mu              sync.Mutex
	compact         *application.WebviewWindow
	compactExpanded bool
	main            *application.WebviewWindow
	mainDirty       bool
	storage         *sqliteadapter.Lifecycle
}

const (
	compactCollapsedWidth = 360
	compactExpandedWidth  = 420
	compactDefaultHeight  = 180
	compactMinWidth       = 320
	compactMinHeight      = 160
	compactSnapDistance   = 16
	mainCompactGap        = 16
)

func NewWindowService(storage *sqliteadapter.Lifecycle) (*WindowService, *WindowController) {
	controller := &WindowController{storage: storage}
	return &WindowService{controller: controller}, controller
}

func (s *WindowController) Attach(app *application.App) {
	s.app = app
}

func (s *WindowController) SetCompact(window *application.WebviewWindow) {
	s.mu.Lock()
	s.compact = window
	s.mu.Unlock()
	window.SetAlwaysOnTop(true)
	window.SetMinimiseButtonState(application.ButtonDisabled)
	window.SetMaximiseButtonState(application.ButtonDisabled)
	s.registerPlacement(window, "compact", compactCollapsedWidth, compactDefaultHeight, compactMinWidth, compactMinHeight)

	window.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
		s.savePlacement(window, "compact")
		event.Cancel()
		window.EmitEvent("app:quit-requested")
	})
}

func (s *WindowService) OpenMain(ctx context.Context) {
	s.controller.OpenMainRoute(ctx, "/overview")
}

// OpenMainRoute opens the one main window at a fixed Phase 1 route. Arbitrary
// URLs are not accepted at the desktop boundary.
func (s *WindowService) OpenMainRoute(ctx context.Context, route string) error {
	if !validMainRoute(route) {
		return fmt.Errorf("unsupported main route %q", route)
	}
	s.controller.OpenMainRoute(ctx, route)
	return nil
}

// SetCompactExpanded changes the T01 width while retaining its saved placement.
// The saved width is also the persisted expanded state.
func (s *WindowService) SetCompactExpanded(_ context.Context, expanded bool) {
	s.controller.SetCompactExpanded(expanded)
}

func (s *WindowController) OpenMainRoute(_ context.Context, route string) {
	s.mu.Lock()
	if s.main != nil {
		window := s.main
		s.mu.Unlock()
		if window.IsMinimised() {
			window.Restore()
		}
		s.placeMainWithoutCompactOverlap(window)
		window.Show()
		window.Focus()
		window.EmitEvent("navigation:open", route)
		return
	}
	defer s.mu.Unlock()

	window := s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Token Monitor Analytics",
		Width:            1280,
		Height:           800,
		MinWidth:         1024,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(250, 250, 250),
		URL:              "/?window=main&route=" + url.QueryEscape(route),
	})
	s.main = window
	s.registerPlacement(window, "main", 1280, 800, 1024, 640)
	window.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
		s.savePlacement(window, "main")
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.mainDirty {
			event.Cancel()
			window.EmitEvent("window:main-close-requested")
			return
		}
		s.main = nil
	})
	window.Show()
}

func validMainRoute(route string) bool {
	switch route {
	case "/overview", "/hubs", "/review", "/catalog", "/accounts", "/evidence", "/audit", "/settings", "/limits":
		return true
	}
	if !strings.HasPrefix(route, "/limits/") {
		return false
	}
	seriesID := strings.TrimPrefix(route, "/limits/")
	return seriesID != "" && !strings.ContainsAny(seriesID, "/?#")
}

func (s *WindowService) SetMainDirty(_ context.Context, dirty bool) {
	s.controller.SetMainDirty(dirty)
}

func (s *WindowController) SetMainDirty(dirty bool) {
	s.mu.Lock()
	s.mainDirty = dirty
	s.mu.Unlock()
}

func (s *WindowService) ConfirmCloseMain(ctx context.Context) {
	s.controller.ConfirmCloseMain(ctx)
}

func (s *WindowController) ConfirmCloseMain(context.Context) {
	s.mu.Lock()
	window := s.main
	s.main = nil
	s.mainDirty = false
	s.mu.Unlock()
	if window != nil {
		window.Close()
	}
}

func (s *WindowService) ConfirmQuit(context.Context) {
	s.controller.app.Quit()
}

func (s *WindowController) SetCompactExpanded(expanded bool) {
	s.mu.Lock()
	compact := s.compact
	s.compactExpanded = expanded
	s.mu.Unlock()
	if compact == nil {
		return
	}
	s.normalizePlacement(compact, "compact")
}

func (s *WindowController) registerPlacement(window *application.WebviewWindow, kind string, defaultWidth, defaultHeight, minWidth, minHeight int) {
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		s.restorePlacement(window, kind, defaultWidth, defaultHeight, minWidth, minHeight)
	})
	for _, eventType := range []events.WindowEventType{
		events.Common.WindowDidMove,
		events.Common.WindowDidResize,
		events.Common.WindowDPIChanged,
	} {
		window.OnWindowEvent(eventType, func(*application.WindowEvent) {
			s.normalizePlacement(window, kind)
		})
	}
}

func (s *WindowController) restorePlacement(window *application.WebviewWindow, kind string, defaultWidth, defaultHeight, minWidth, minHeight int) {
	if s.storage == nil || s.app == nil {
		return
	}
	placement, found, err := s.storage.GetWindowPlacement(context.Background(), kind)
	if err != nil {
		log.Printf("restore %s window placement: %v", kind, err)
		return
	}
	screen := (*application.Screen)(nil)
	if found {
		screen = s.app.Screen.GetByID(placement.Monitor)
	}
	if screen == nil && kind == "main" {
		s.mu.Lock()
		compact := s.compact
		s.mu.Unlock()
		if compact != nil {
			screen, _ = compact.GetScreen()
		}
	}
	if screen == nil {
		screen = s.app.Screen.GetPrimary()
	}
	if screen == nil {
		return
	}
	bounds := application.Rect{Width: defaultWidth, Height: defaultHeight}
	if found {
		bounds = application.Rect{X: placement.X, Y: placement.Y, Width: placement.Width, Height: placement.Height}
	} else {
		current := window.Bounds()
		if current.Width > 0 && current.Height > 0 {
			bounds = current
		}
	}
	if kind == "compact" {
		s.mu.Lock()
		s.compactExpanded = found && placement.Width >= compactExpandedWidth
		expanded := s.compactExpanded
		s.mu.Unlock()
		bounds = compactWindowBounds(bounds, screen.WorkArea, expanded)
		setCompactWindowConstraints(window, screen.WorkArea, expanded)
	} else {
		window.SetMinSize(min(minWidth, screen.WorkArea.Width), min(minHeight, screen.WorkArea.Height))
		bounds = fitWindowBounds(bounds, screen.WorkArea)
	}
	window.SetBounds(bounds)
	if kind == "main" {
		s.placeMainWithoutCompactOverlap(window)
	}
}

func (s *WindowController) normalizePlacement(window *application.WebviewWindow, kind string) {
	if window == nil {
		return
	}
	screen, err := window.GetScreen()
	if err != nil || screen == nil {
		return
	}
	if kind == "compact" {
		s.mu.Lock()
		expanded := s.compactExpanded
		s.mu.Unlock()
		setCompactWindowConstraints(window, screen.WorkArea, expanded)
		current := window.Bounds()
		bounds := compactWindowBounds(current, screen.WorkArea, expanded)
		if bounds != current {
			window.SetBounds(bounds)
		}
	} else if kind == "main" {
		s.placeMainWithoutCompactOverlap(window)
	}
	s.savePlacement(window, kind)
}

func (s *WindowController) placeMainWithoutCompactOverlap(window *application.WebviewWindow) {
	if window == nil {
		return
	}
	screen, err := window.GetScreen()
	if err != nil || screen == nil {
		return
	}
	bounds := fitWindowBounds(window.Bounds(), screen.WorkArea)
	s.mu.Lock()
	compact := s.compact
	s.mu.Unlock()
	if compact != nil {
		bounds = placeWindowWithoutOverlap(bounds, compact.Bounds(), screen.WorkArea, mainCompactGap)
	}
	if bounds != window.Bounds() {
		window.SetBounds(bounds)
	}
}

func (s *WindowController) savePlacement(window *application.WebviewWindow, kind string) {
	if s.storage == nil || window == nil || window.IsMinimised() || window.IsMaximised() || window.IsFullscreen() {
		return
	}
	screen, err := window.GetScreen()
	if err != nil || screen == nil {
		return
	}
	bounds := window.Bounds()
	placement := sqliteadapter.WindowPlacement{
		X: bounds.X, Y: bounds.Y, Width: bounds.Width, Height: bounds.Height,
		DPI: int(math.Round(float64(screen.ScaleFactor) * 96)), Monitor: screen.ID,
	}
	if err := s.storage.SaveWindowPlacement(context.Background(), kind, placement); err != nil {
		log.Printf("save %s window placement: %v", kind, err)
	}
}

func fitWindowBounds(bounds, workArea application.Rect) application.Rect {
	if workArea.Width <= 0 || workArea.Height <= 0 {
		return bounds
	}
	bounds.Width = min(max(bounds.Width, 1), workArea.Width)
	bounds.Height = min(max(bounds.Height, 1), workArea.Height)
	bounds.X = min(max(bounds.X, workArea.X), workArea.X+workArea.Width-bounds.Width)
	bounds.Y = min(max(bounds.Y, workArea.Y), workArea.Y+workArea.Height-bounds.Height)
	return bounds
}

func compactWindowBounds(bounds, workArea application.Rect, expanded bool) application.Rect {
	width := compactCollapsedWidth
	if expanded {
		width = compactExpandedWidth
	}
	bounds.Width = width
	if !expanded || bounds.Height <= 0 {
		bounds.Height = compactDefaultHeight
	}
	heightLimit := compactHeightLimit(workArea)
	bounds.Height = min(max(bounds.Height, min(compactMinHeight, heightLimit)), heightLimit)
	return snapWindowBounds(fitWindowBounds(bounds, workArea), workArea, compactSnapDistance)
}

func compactHeightLimit(workArea application.Rect) int {
	if workArea.Height <= 0 {
		return compactDefaultHeight
	}
	return max(1, workArea.Height/2)
}

func setCompactWindowConstraints(window *application.WebviewWindow, workArea application.Rect, expanded bool) {
	minWidth, minHeight, maxWidth, maxHeight := compactConstraintBounds(workArea, expanded)
	window.SetMinSize(minWidth, minHeight)
	window.SetMaxSize(maxWidth, maxHeight)
}

func compactConstraintBounds(workArea application.Rect, expanded bool) (minWidth, minHeight, maxWidth, maxHeight int) {
	width := compactCollapsedWidth
	if expanded {
		width = compactExpandedWidth
	}
	effectiveWidth := min(width, max(workArea.Width, 1))
	effectiveHeight := min(compactHeightLimit(workArea), max(workArea.Height, 1))
	return min(compactMinWidth, effectiveWidth), min(compactMinHeight, effectiveHeight), effectiveWidth, effectiveHeight
}

func snapWindowBounds(bounds, workArea application.Rect, distance int) application.Rect {
	bounds = fitWindowBounds(bounds, workArea)
	if workArea.Width <= 0 || workArea.Height <= 0 || distance < 0 {
		return bounds
	}
	right := workArea.X + workArea.Width - bounds.Width
	bottom := workArea.Y + workArea.Height - bounds.Height
	if abs(bounds.X-workArea.X) <= distance {
		bounds.X = workArea.X
	} else if abs(bounds.X-right) <= distance {
		bounds.X = right
	}
	if abs(bounds.Y-workArea.Y) <= distance {
		bounds.Y = workArea.Y
	} else if abs(bounds.Y-bottom) <= distance {
		bounds.Y = bottom
	}
	return bounds
}

func placeWindowWithoutOverlap(preferred, obstacle, workArea application.Rect, gap int) application.Rect {
	preferred = fitWindowBounds(preferred, workArea)
	if !rectsOverlap(preferred, obstacle) {
		return preferred
	}
	candidates := []application.Rect{
		{X: obstacle.X + obstacle.Width + gap, Y: preferred.Y, Width: preferred.Width, Height: preferred.Height},
		{X: obstacle.X - preferred.Width - gap, Y: preferred.Y, Width: preferred.Width, Height: preferred.Height},
		{X: preferred.X, Y: obstacle.Y + obstacle.Height + gap, Width: preferred.Width, Height: preferred.Height},
		{X: preferred.X, Y: obstacle.Y - preferred.Height - gap, Width: preferred.Width, Height: preferred.Height},
	}
	for _, candidate := range candidates {
		if fitsWindowBounds(candidate, workArea) && !rectsOverlap(candidate, obstacle) {
			return candidate
		}
	}
	return preferred
}

func fitsWindowBounds(bounds, workArea application.Rect) bool {
	return bounds.X >= workArea.X && bounds.Y >= workArea.Y &&
		bounds.X+bounds.Width <= workArea.X+workArea.Width &&
		bounds.Y+bounds.Height <= workArea.Y+workArea.Height
}

func rectsOverlap(left, right application.Rect) bool {
	return left.Width > 0 && left.Height > 0 && right.Width > 0 && right.Height > 0 &&
		left.X < right.X+right.Width && left.X+left.Width > right.X &&
		left.Y < right.Y+right.Height && left.Y+left.Height > right.Y
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
