package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"token-monitor-analytics/internal/app"
	"token-monitor-analytics/internal/credential"
	"token-monitor-analytics/internal/storage"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	storePath, err := databasePath()
	if err != nil {
		log.Fatal(err)
	}
	store, err := storage.Open(storePath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	service, err := app.NewService(store, credential.New())
	if err != nil {
		log.Fatal(err)
	}
	applicationApp := application.New(application.Options{
		Name:        "Token Monitor Analytics",
		Description: "Local Token Monitor usage history and estimates",
		Services: []application.Service{
			application.NewService(service),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	applicationApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Token Monitor Analytics",
		Width:            1180,
		Height:           760,
		BackgroundColour: application.NewRGB(15, 23, 42),
		URL:              "/",
	})

	if err := service.Start(); err != nil {
		log.Printf("periodic collection is disabled: %v", err)
	}
	defer service.Stop()

	if err := applicationApp.Run(); err != nil {
		log.Fatal(err)
	}
}

func databasePath() (string, error) {
	if override := os.Getenv("TOKEN_MONITOR_ANALYTICS_DB"); override != "" {
		return override, nil
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "Token Monitor Analytics", "data.db"), nil
}
