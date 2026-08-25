package desktop

import (
	"context"
	"log"
	"math"
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

	mu        sync.Mutex
	compact   *application.WebviewWindow
	main      *application.WebviewWindow
	mainDirty bool
	storage   *sqliteadapter.Lifecycle
}

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
	s.registerPlacement(window, "compact", 360, 180, 320, 160)

	window.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
		s.savePlacement(window, "compact")
		event.Cancel()
		window.EmitEvent("app:quit-requested")
	})
}

func (s *WindowService) OpenMain(ctx context.Context) {
	s.controller.OpenMain(ctx)
}

func (s *WindowController) OpenMain(context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.main != nil {
		if s.main.IsMinimised() {
			s.main.Restore()
		}
		s.main.Show()
		s.main.Focus()
		return
	}

	window := s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Token Monitor Analytics",
		Width:            1280,
		Height:           800,
		MinWidth:         1024,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(250, 250, 250),
		URL:              "/?window=main",
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
			s.savePlacement(window, kind)
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
	window.SetMinSize(min(minWidth, screen.WorkArea.Width), min(minHeight, screen.WorkArea.Height))
	window.SetBounds(fitWindowBounds(bounds, screen.WorkArea))
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
