package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"token-monitor-analytics/collector/internal/bridge"
	"token-monitor-analytics/collector/internal/config"
)

func main() {
	path := flag.String("config", "config.local.json", "collector configuration")
	check := flag.Bool("check", false, "validate configuration and environment without connecting")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	c, e := config.Load(*path)
	if e != nil {
		log.Error("configuration error", "error", e)
		os.Exit(1)
	}
	if *check {
		log.Info("configuration valid", "hubs", len(c.Hubs))
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if e = bridge.Run(ctx, c, log); e != nil {
		log.Error("collector stopped; unsent data remains in outbox", "error", e)
		os.Exit(1)
	}
}
