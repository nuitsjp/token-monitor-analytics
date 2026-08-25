package desktop

import (
	"context"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
}

func NewWindowService() (*WindowService, *WindowController) {
	controller := &WindowController{}
	return &WindowService{controller: controller}, controller
}

func (s *WindowController) Attach(app *application.App) {
	s.app = app
}

func (s *WindowController) SetCompact(window *application.WebviewWindow) {
	s.mu.Lock()
	s.compact = window
	s.mu.Unlock()

	window.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
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
		Width:            1120,
		Height:           760,
		MinWidth:         720,
		MinHeight:        540,
		BackgroundColour: application.NewRGB(250, 250, 250),
		URL:              "/?window=main",
	})
	s.main = window
	window.OnWindowEvent(events.Common.WindowClosing, func(event *application.WindowEvent) {
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
