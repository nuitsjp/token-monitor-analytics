package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Hub struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	SecretEnv string `json:"secret_env"`
}
type Config struct {
	Version        int    `json:"version"`
	Hubs           []Hub  `json:"hubs"`
	AnalyticsURL   string `json:"analytics_url"`
	IngestTokenEnv string `json:"ingest_token_env"`
	SpoolDir       string `json:"spool_dir"`
	MaxSpoolBytes  int64  `json:"max_spool_bytes"`
	FlushSeconds   int    `json:"flush_seconds"`
	BatchSize      int    `json:"batch_size"`
	IdleSeconds    int    `json:"idle_seconds"`
}

var safeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

func ValidID(s string) bool { return safeID.MatchString(s) }
func ValidateBaseURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil {
		return errors.New("invalid origin URL")
	}
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("URL must be an origin, without path, credentials, query or fragment")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return errors.New("HTTPS required (HTTP is allowed only on loopback)")
	}
	return nil
}
func Secret(name string) (string, error) {
	s := os.Getenv(name)
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return "", fmt.Errorf("missing or invalid environment variable: %s", name)
	}
	return s, nil
}
func Load(path string) (Config, error) {
	var c Config
	f, e := os.Open(path)
	if e != nil {
		return c, e
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, 1<<20))
	d.DisallowUnknownFields()
	if e = d.Decode(&c); e != nil {
		return c, e
	}
	var extra any
	if e = d.Decode(&extra); e != io.EOF {
		return c, errors.New("config must contain exactly one JSON object")
	}
	if c.Version != 1 || len(c.Hubs) == 0 || len(c.Hubs) > 8 {
		return c, errors.New("version must be 1; configure 1..8 hubs")
	}
	if e = ValidateBaseURL(c.AnalyticsURL); e != nil {
		return c, fmt.Errorf("analytics_url: %w", e)
	}
	ids, urls := map[string]bool{}, map[string]bool{}
	for _, h := range c.Hubs {
		if !ValidID(h.ID) || ids[h.ID] {
			return c, errors.New("invalid or duplicate hub id")
		}
		ids[h.ID] = true
		if e = ValidateBaseURL(h.URL); e != nil {
			return c, fmt.Errorf("hub %s: %w", h.ID, e)
		}
		key := strings.ToLower(strings.TrimSuffix(h.URL, "/"))
		if urls[key] {
			return c, errors.New("duplicate hub URL")
		}
		urls[key] = true
		if _, e = Secret(h.SecretEnv); e != nil {
			return c, e
		}
	}
	if _, e = Secret(c.IngestTokenEnv); e != nil {
		return c, e
	}
	if c.SpoolDir == "" {
		c.SpoolDir = "./data/outbox"
	}
	if !filepath.IsAbs(c.SpoolDir) {
		a, e := filepath.Abs(path)
		if e != nil {
			return c, e
		}
		c.SpoolDir = filepath.Join(filepath.Dir(a), c.SpoolDir)
	}
	if c.MaxSpoolBytes == 0 {
		c.MaxSpoolBytes = 256 << 20
	}
	if c.MaxSpoolBytes < 1<<20 {
		return c, errors.New("max_spool_bytes must be >= 1 MiB")
	}
	if c.FlushSeconds == 0 {
		c.FlushSeconds = 2
	}
	if c.FlushSeconds < 1 || c.FlushSeconds > 60 {
		return c, errors.New("flush_seconds must be 1..60")
	}
	if c.BatchSize == 0 {
		c.BatchSize = 2
	}
	if c.BatchSize < 1 || c.BatchSize > 2 {
		return c, errors.New("batch_size must be 1..2 (server query budget)")
	}
	if c.IdleSeconds == 0 {
		c.IdleSeconds = 90
	}
	if c.IdleSeconds < 30 {
		return c, errors.New("idle_seconds must be >=30")
	}
	return c, nil
}
