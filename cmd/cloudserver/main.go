package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"token-monitor-analytics/internal/cloudserver"
)

func main() {
	address := os.Getenv("TOKEN_MONITOR_ANALYTICS_CLOUD_ADDR")
	if address == "" {
		address = ":8080"
	}
	databasePath := os.Getenv("TOKEN_MONITOR_ANALYTICS_CLOUD_DB")
	if databasePath == "" {
		databasePath = "cloud.db"
	}
	secretFile := os.Getenv("TOKEN_MONITOR_ANALYTICS_CLOUD_SECRET_FILE")
	if secretFile == "" {
		log.Fatal("TOKEN_MONITOR_ANALYTICS_CLOUD_SECRET_FILE is required")
	}
	secretBytes, err := os.ReadFile(secretFile)
	if err != nil {
		log.Fatalf("read cloud secret file: %v", err)
	}
	secret := strings.TrimSpace(string(secretBytes))
	clear(secretBytes)
	server, err := cloudserver.New(databasePath, secret)
	if err != nil {
		log.Fatal(err)
	}
	defer server.Close()
	log.Printf("Token Monitor Analytics cloud server listening on %s", address)
	if err := http.ListenAndServe(address, server.Handler()); err != nil {
		log.Fatal(err)
	}
}
